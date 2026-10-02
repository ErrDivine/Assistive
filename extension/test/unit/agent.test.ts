import * as assert from "node:assert";
import type { LlmConfig } from "../../src/config/env";
import { type AgentTool, Llm, LlmError, stripThinking } from "../../src/llm/agent";
import { FakeServers, lastMessage, toolNames } from "../support/fakeServers";

const cfg = (base: string, extra: Partial<LlmConfig> = {}): LlmConfig => ({
  baseUrl: `${base}/v1`,
  apiKey: "sk-test",
  model: "fake-model",
  temperature: 0.2,
  timeoutMs: 5000,
  maxToolRounds: 4,
  extraHeaders: {},
  ...extra,
});

const echo: AgentTool<{ text: string; times?: number }> = {
  name: "echo",
  description: "Echo text.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: { text: { type: "string" }, times: { type: "integer", minimum: 1, maximum: 3 } },
  },
  run: ({ text, times }) => `echo: ${text.repeat(times ?? 1)}`,
};

const stopper: AgentTool<{ reason: string }> = {
  name: "stand_down",
  description: "Stop.",
  parameters: { type: "object", required: ["reason"], properties: { reason: { type: "string" } } },
  run: ({ reason }, ctx) => {
    ctx.stop = { reason };
    return "ok.";
  },
};

describe("Llm.run (OpenAI tool-calling loop)", () => {
  let fake: FakeServers;
  before(async () => {
    fake = await new FakeServers().start();
  });
  after(() => fake.stop());
  beforeEach(() => fake.reset());

  it("sends tools in OpenAI format, runs calls, returns the final text", async () => {
    fake.chat = (req) =>
      lastMessage(req).role === "tool"
        ? { content: "<think>hidden</think>Done: echoed twice." }
        : { calls: [{ name: "echo", args: { text: "hi" } }, { name: "echo", args: { text: "yo", times: "2" } }] };
    const llm = new Llm(cfg(fake.base));
    const steps: string[] = [];
    const r = await llm.run({
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }],
      tools: [echo as unknown as AgentTool],
      onStep: (s) => steps.push(s.result),
    });
    assert.strictEqual(r.text, "Done: echoed twice.");
    assert.strictEqual(r.rounds, 2);
    assert.deepStrictEqual(steps, ["echo: hi", "echo: yoyo"]);
    assert.deepStrictEqual(r.usage, { prompt: 200, completion: 40 });
    const first = fake.chatRequests[0];
    assert.strictEqual(first.model, "fake-model");
    assert.strictEqual(first.temperature, 0.2);
    assert.strictEqual(first.tool_choice, "auto");
    assert.ok(!("parallel_tool_calls" in first), "parallel_tool_calls is never sent");
    assert.deepStrictEqual(toolNames(first), ["echo"]);
    assert.strictEqual(first.tools![0].type, "function");
    const second = fake.chatRequests[1];
    const roles = second.messages.map((m) => m.role);
    assert.deepStrictEqual(roles, ["system", "user", "assistant", "tool", "tool"]);
    assert.strictEqual(second.messages[3].tool_call_id, (second.messages[2].tool_calls as { id: string }[])[0].id);
  });

  it("returns actionable errors for bad tool calls instead of throwing", async () => {
    fake.chat = (req, i) =>
      i === 0
        ? {
            calls: [
              { name: "nope", args: {} },
              { name: "echo", args: "{not json" },
              { name: "echo", args: { times: 9 } },
              { name: "echo", args: { text: "x", extra: 1 } },
            ],
          }
        : { content: `saw ${req.messages.filter((m) => m.role === "tool").length} results` };
    const llm = new Llm(cfg(fake.base));
    const r = await llm.run({ messages: [{ role: "user", content: "go" }], tools: [echo as unknown as AgentTool] });
    const results = r.steps.map((s) => s.result);
    assert.match(results[0], /no tool named 'nope'. Available tools: echo/);
    assert.match(results[1], /not valid JSON/);
    assert.match(results[2], /arguments.text is required.*arguments.times must be between 1 and 3/);
    assert.match(results[3], /echo: x\n\(note: ignored unknown field\(s\) arguments.extra\)/);
    assert.deepStrictEqual(r.steps.map((s) => s.ok), [false, false, false, true]);
    assert.strictEqual(r.text, "saw 4 results");
  });

  it("stops early when a tool asks to", async () => {
    fake.chat = () => ({ calls: [{ name: "stand_down", args: { reason: "fine" } }] });
    const r = await new Llm(cfg(fake.base)).run({ messages: [{ role: "user", content: "go" }], tools: [stopper as unknown as AgentTool] });
    assert.strictEqual(r.stopped, "fine");
    assert.strictEqual(fake.chatRequests.length, 1);
  });

  it("asks for a summary with tool_choice none when the round budget is spent", async () => {
    fake.chat = (req) => (req.tool_choice === "none" ? { content: "Summary after budget." } : { calls: [{ name: "echo", args: { text: "again" } }] });
    const r = await new Llm(cfg(fake.base, { maxToolRounds: 2 })).run({ messages: [{ role: "user", content: "go" }], tools: [echo as unknown as AgentTool] });
    assert.strictEqual(r.text, "Summary after budget.");
    assert.strictEqual(fake.chatRequests.length, 3);
    assert.match(lastMessage(fake.chatRequests[2]).content ?? "", /Tool budget reached/);
  });

  it("retries without temperature for models that reject it", async () => {
    fake.chat = (req) =>
      "temperature" in req ? { status: 400, error: "Unsupported parameter: 'temperature' is not supported with this model." } : { content: "fine" };
    const llm = new Llm(cfg(fake.base));
    assert.strictEqual(await llm.text([{ role: "user", content: "hi" }]), "fine");
    assert.strictEqual(await llm.text([{ role: "user", content: "again" }]), "fine");
    assert.strictEqual(fake.chatRequests.length, 3, "the second call no longer sends temperature");
  });

  it("falls back when response_format is not supported", async () => {
    fake.chat = (req) => (req.response_format ? { status: 400, error: "response_format not supported" } : { content: '{"a":1}' });
    assert.strictEqual(await new Llm(cfg(fake.base)).text([{ role: "user", content: "json" }], undefined, true), '{"a":1}');
  });

  it("turns HTTP failures into helpful errors", async () => {
    fake.chat = () => ({ status: 401, error: "bad key" });
    await assert.rejects(new Llm(cfg(fake.base)).text([{ role: "user", content: "x" }]), (e: LlmError) => {
      assert.match(e.message, /ASSISTIVE_LLM_API_KEY/);
      return true;
    });
    fake.chat = () => ({ status: 404, error: "model not found" });
    await assert.rejects(new Llm(cfg(fake.base)).text([{ role: "user", content: "x" }]), /ASSISTIVE_LLM_BASE_URL.*fake-model/);
    await assert.rejects(new Llm(cfg("http://127.0.0.1:9", { timeoutMs: 1000 })).text([{ role: "user", content: "x" }]), /Could not reach the LLM|did not answer/);
  });

  it("sends extra headers", async () => {
    let seen = "";
    const llm = new Llm(cfg("https://llm.example", { extraHeaders: { "X-Title": "Assistive" } }), async (_url, init) => {
      seen = new Headers(init?.headers).get("x-title") ?? "";
      return Response.json({ id: "1", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }] });
    });
    assert.strictEqual(await llm.text([{ role: "user", content: "x" }]), "ok");
    assert.strictEqual(seen, "Assistive");
  });

  it("strips <think> blocks", () => {
    assert.strictEqual(stripThinking("<think>a\nb</think>\n Answer"), "Answer");
  });
});
