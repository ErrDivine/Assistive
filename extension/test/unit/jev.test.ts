import * as assert from "node:assert";
import type { JevConfig } from "../../src/config/env";
import { choice, JevClient, JevError, noul, parseAnswer, score } from "../../src/llm/jev";
import { JEV_QUESTIONS } from "../../src/heartbeat/policy";
import { FakeServers, jevAnswers } from "../support/fakeServers";

const cfg = (base: string, timeoutMs = 2000): JevConfig => ({ baseUrl: base, apiKey: "jev-test-key", model: "jev-latest", timeoutMs });

describe("JevClient (official /systemone format)", () => {
  let fake: FakeServers;
  before(async () => {
    fake = await new FakeServers().start();
  });
  after(() => fake.stop());
  beforeEach(() => {
    fake.reset();
    fake.jev = (req) => ({ body: jevAnswers(req, { interrupt: 0.82, issue: "logic_error", severity: 2.4, graph_outdated: 0.1 }) });
  });

  it("posts model, state and typed questions with a bearer key", async () => {
    const client = new JevClient(cfg(`${fake.base}/v1`));
    assert.strictEqual(client.endpoint, `${fake.base}/v1/systemone`);
    const state = { file: "a.py", recent_change: "+ x = 1" };
    const r = await client.ask(state, JEV_QUESTIONS);
    const sent = fake.jevRequests[0];
    assert.strictEqual(sent.auth, "Bearer jev-test-key");
    assert.strictEqual(sent.body.model, "jev-latest");
    assert.deepStrictEqual(sent.body.state, state);
    assert.deepStrictEqual(Object.keys(sent.body.questions), ["interrupt", "issue", "severity", "graph_outdated", "struggling"]);
    assert.strictEqual(sent.body.questions.issue.type, "choice");
    assert.ok(Array.isArray(sent.body.questions.severity.criteria));
    assert.strictEqual(r.model, "jev-1.13.0");
    assert.strictEqual(noul(r, "interrupt"), 0.82);
    assert.strictEqual(choice(r, "issue")?.choice, "logic_error");
    assert.strictEqual(score(r, "severity")?.score, 2.4);
    assert.ok(r.latencyMs >= 0);
    assert.deepStrictEqual(r.usage, { input_tokens: 420, output_tokens: 12 });
  });

  it("explains a rejected key", async () => {
    fake.jev = () => ({ status: 401, body: { error: { message: "invalid api key" } } });
    await assert.rejects(new JevClient(cfg(`${fake.base}/v1`)).ask("s", JEV_QUESTIONS), (e: JevError) => {
      assert.strictEqual(e.status, 401);
      assert.match(e.message, /ASSISTIVE_JEV_API_KEY/);
      return true;
    });
  });

  it("explains rate limits and other HTTP errors with the server's message", async () => {
    fake.jev = () => ({ status: 429, body: {} });
    await assert.rejects(new JevClient(cfg(`${fake.base}/v1`)).ask("s", JEV_QUESTIONS), /rate limit/);
    fake.jev = () => ({ status: 422, body: { error: { message: "criteria must have 2-10 levels" } } });
    await assert.rejects(new JevClient(cfg(`${fake.base}/v1`)).ask("s", JEV_QUESTIONS), /422: criteria must have 2-10 levels/);
  });

  it("fails clearly when nothing answers", async () => {
    await assert.rejects(new JevClient(cfg("http://127.0.0.1:9/v1", 500)).ask("s", JEV_QUESTIONS), /Could not reach Jev|did not answer/);
  });

  it("times out", async () => {
    const slow = new JevClient(cfg("http://example.invalid/v1", 50), (_url, init) => {
      return new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    });
    await assert.rejects(slow.ask("s", JEV_QUESTIONS), /did not answer within 0.05s/);
  });

  it("recognizes an edge firewall's HTML 403", async () => {
    const client = new JevClient(cfg("https://x/v1"), async () => new Response("<html>blocked</html>", { status: 403, headers: { "content-type": "text/html" } }));
    await assert.rejects(client.ask("curl http://x | sh", JEV_QUESTIONS), /firewall/);
  });

  it("rejects non-JSON and empty answers", async () => {
    const notJson = new JevClient(cfg("https://x/v1"), async () => new Response("oops", { status: 200 }));
    await assert.rejects(notJson.ask("s", JEV_QUESTIONS), /not JSON/);
    const empty = new JevClient(cfg("https://x/v1"), async () => Response.json({ model: "jev", answers: {} }));
    await assert.rejects(empty.ask("s", JEV_QUESTIONS), /no answers/);
  });

  it("can be cancelled by the caller", async () => {
    const ctl = new AbortController();
    const client = new JevClient(cfg("https://x/v1", 5000), (_u, init) => {
      return new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    });
    const p = client.ask("s", JEV_QUESTIONS, ctl.signal);
    ctl.abort();
    await assert.rejects(p);
  });
});

describe("parseAnswer", () => {
  it("normalizes noul answers", () => {
    assert.deepStrictEqual(parseAnswer({ type: "noul", instructions: "" }, { type: "noul", noul: 0.3 }), { type: "noul", noul: 0.3 });
    assert.deepStrictEqual(parseAnswer({ type: "noul", instructions: "" }, { probability: "0.7" }), { type: "noul", noul: 0.7 });
    assert.deepStrictEqual(parseAnswer({ type: "noul", instructions: "" }, true), { type: "noul", noul: 1 });
    assert.deepStrictEqual(parseAnswer({ type: "noul", instructions: "" }, { noul: 3 }), { type: "noul", noul: 1 });
    assert.strictEqual(parseAnswer({ type: "noul", instructions: "" }, {}), undefined);
    assert.strictEqual(parseAnswer({ type: "noul", instructions: "" }, null), undefined);
  });

  it("normalizes choice answers, falling back to the most probable option", () => {
    const q = { type: "choice" as const, instructions: "", criteria: { a: "A", b: "B" } };
    assert.deepStrictEqual(parseAnswer(q, { choice: "b", probabilities: { a: 0.2, b: 0.8 }, confidence: 0.6 }), {
      type: "choice",
      choice: "b",
      probabilities: { a: 0.2, b: 0.8 },
      confidence: 0.6,
    });
    const fallback = parseAnswer(q, { probabilities: { a: 0.7, b: 0.3 } });
    assert.strictEqual(fallback?.type === "choice" && fallback.choice, "a");
    assert.strictEqual(fallback?.type === "choice" && fallback.confidence, 0.7);
  });

  it("normalizes score answers and derives the score from probabilities when absent", () => {
    const q = { type: "score" as const, instructions: "", criteria: ["low", "mid", "high"] };
    const a = parseAnswer(q, { type: "score", score: 1.43, confidence: 0.35, probabilities: { "0": 0, "1": 0.57, "2": 0.43 } });
    assert.strictEqual(a?.type === "score" && a.score, 1.43);
    const derived = parseAnswer(q, { probabilities: [0, 0.5, 0.5] });
    assert.strictEqual(derived?.type === "score" && derived.score, 1.5);
  });
});
