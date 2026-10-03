import * as assert from "node:assert";
import { parse as parseDotenv } from "dotenv";
import { ENV_TEMPLATE } from "../../src/config/env";
import { chatModels, listModels, PROVIDERS, quoteEnvValue, runSetup, setEnvValues, type PickItem, type SetupDeps, type SetupUi } from "../../src/config/setup";
import { FakeServers } from "../support/fakeServers";

type Step = { pick: string } | { input: string } | { cancel: true };

/** A UI that answers from a script and records what it was asked. */
function scripted(steps: Step[]) {
  const asked: { kind: "pick" | "input"; title: string; text: string; labels?: string[]; placeholder?: string; validate?: (v: string) => string | undefined }[] = [];
  const ui: SetupUi = {
    async pick<T extends PickItem>(items: T[], opts: { title: string; placeholder: string }) {
      asked.push({ kind: "pick", title: opts.title, text: opts.placeholder, labels: items.map((i) => i.label) });
      const s = steps.shift();
      assert.ok(s && !("input" in s), `unexpected pick: ${opts.placeholder}`);
      if ("cancel" in s) return undefined;
      const hit = items.find((i) => i.label === s.pick);
      assert.ok(hit, `no item ${s.pick} in ${items.map((i) => i.label).join(", ")}`);
      return hit;
    },
    async input(opts) {
      asked.push({ kind: "input", title: opts.title, text: opts.prompt, placeholder: opts.placeholder, validate: opts.validate });
      const s = steps.shift();
      assert.ok(s && !("pick" in s), `unexpected input: ${opts.prompt}`);
      if ("cancel" in s) return undefined;
      assert.strictEqual(opts.validate?.(s.input), undefined, `the answer ${s.input} is valid`);
      return s.input;
    },
  };
  return { ui, asked, done: () => assert.deepStrictEqual(steps, [], "every scripted answer was used") };
}

const FRESH: SetupDeps["current"] = { baseUrl: "https://api.openai.com/v1", apiKey: "REPLACE_ME", model: "REPLACE_ME", triage: "jev", jevReady: false };
const READY: SetupDeps["current"] = { baseUrl: "https://api.openai.com/v1", apiKey: "sk-old", model: "gpt-old", triage: "jev", jevReady: true };

function deps(current: SetupDeps["current"], models: string[] | Error = ["gpt-b", "text-embedding-3-small", "gpt-a"]) {
  const calls: { baseUrl: string; apiKey: string }[] = [];
  const d: SetupDeps = {
    current,
    listModels: async (baseUrl, apiKey) => {
      calls.push({ baseUrl, apiKey });
      if (models instanceof Error) throw models;
      return models;
    },
  };
  return { d, calls };
}

describe("setup: runSetup", () => {
  it("OpenAI: key, a model from the endpoint's list, and LLM triage when Jev is missing", async () => {
    const s = scripted([{ pick: "OpenAI" }, { input: " sk-new " }, { pick: "gpt-b" }, { pick: "Triage with the LLM" }]);
    const { d, calls } = deps(FRESH);
    const out = await runSetup(s.ui, d);
    s.done();
    assert.deepStrictEqual(out, {
      ASSISTIVE_LLM_BASE_URL: "https://api.openai.com/v1",
      ASSISTIVE_LLM_API_KEY: "sk-new",
      ASSISTIVE_LLM_MODEL: "gpt-b",
      ASSISTIVE_TRIAGE: "llm",
    });
    assert.deepStrictEqual(calls, [{ baseUrl: "https://api.openai.com/v1", apiKey: "sk-new" }]);
    assert.deepStrictEqual(s.asked[2].labels, ["$(edit) Type a model name…", "gpt-a", "gpt-b"], "embeddings are not offered; sorted");
    assert.strictEqual(s.asked[1].validate?.(""), "Enter the key.", "a new endpoint needs a key");
    assert.strictEqual(s.asked[1].validate?.("a\nb"), "Use one line.");
  });

  it("keeps the current key and marks the current model when the endpoint stays", async () => {
    const s = scripted([{ pick: "OpenAI" }, { input: "" }, { pick: "gpt-a" }]);
    const out = await runSetup(s.ui, deps(READY, ["gpt-a", "gpt-old"]).d);
    s.done();
    assert.strictEqual(out?.ASSISTIVE_LLM_API_KEY, "sk-old");
    assert.strictEqual(s.asked[1].placeholder, "Press Enter to keep the current key");
    assert.ok(!("ASSISTIVE_TRIAGE" in out!), "Jev is ready: no triage question");
    assert.strictEqual(s.asked.length, 3);
  });

  it("Ollama: no key prompt, and a typed model when the endpoint cannot list its models", async () => {
    const s = scripted([{ pick: "Ollama (this computer)" }, { input: "qwen2.5-coder:14b" }, { cancel: true }]);
    const { d, calls } = deps(FRESH, new Error("fetch failed"));
    const out = await runSetup(s.ui, d);
    s.done();
    assert.deepStrictEqual(out, { ASSISTIVE_LLM_BASE_URL: "http://localhost:11434/v1", ASSISTIVE_LLM_API_KEY: "ollama", ASSISTIVE_LLM_MODEL: "qwen2.5-coder:14b" });
    assert.strictEqual(calls[0].apiKey, "ollama");
    assert.match(s.asked[1].text, /did not list its models: fetch failed/);
    assert.strictEqual(s.asked[1].validate?.(" "), "Enter the model name.");
  });

  it("another endpoint: the URL is checked and its trailing slash removed", async () => {
    const s = scripted([{ pick: "Other OpenAI-compatible endpoint…" }, { input: "https://gw.example.com/v1/" }, { input: "k" }, { pick: "$(edit) Type a model name…" }, { input: "my-model" }]);
    const out = await runSetup(s.ui, deps(READY).d);
    s.done();
    assert.strictEqual(out?.ASSISTIVE_LLM_BASE_URL, "https://gw.example.com/v1");
    assert.strictEqual(out?.ASSISTIVE_LLM_MODEL, "my-model");
    assert.match(s.asked[1].validate?.("ftp://x") ?? "", /http/);
    assert.strictEqual(s.asked[3].kind, "pick");
  });

  it("a Jev key can be entered for the heartbeat", async () => {
    const s = scripted([{ pick: "OpenRouter" }, { input: "or-key" }, { pick: "gpt-a" }, { pick: "Enter a Jev API key" }, { input: "jev-key" }]);
    const out = await runSetup(s.ui, deps(FRESH).d);
    s.done();
    assert.strictEqual(out?.ASSISTIVE_JEV_API_KEY, "jev-key");
    assert.strictEqual(out?.ASSISTIVE_LLM_BASE_URL, PROVIDERS[1].baseUrl);
  });

  it("cancelling before the model is chosen writes nothing; cancelling the triage keeps the LLM values", async () => {
    for (const steps of [[{ cancel: true }], [{ pick: "OpenAI" }, { cancel: true }], [{ pick: "OpenAI" }, { input: "k" }, { cancel: true }]] as Step[][]) {
      const s = scripted(steps);
      assert.strictEqual(await runSetup(s.ui, deps(FRESH).d), undefined);
      s.done();
    }
    const s = scripted([{ pick: "OpenAI" }, { input: "k" }, { pick: "gpt-a" }, { cancel: true }]);
    const out = await runSetup(s.ui, deps(FRESH).d);
    assert.deepStrictEqual(Object.keys(out!), ["ASSISTIVE_LLM_BASE_URL", "ASSISTIVE_LLM_API_KEY", "ASSISTIVE_LLM_MODEL"]);
  });
});

describe("setup: helpers", () => {
  it("chatModels drops non-chat models, duplicates, and sorts; keeps all if nothing would remain", () => {
    assert.deepStrictEqual(chatModels(["whisper-1", "gpt-4o", "dall-e-3", "gpt-4o", "o3-mini", "tts-1"]), ["gpt-4o", "o3-mini"]);
    assert.deepStrictEqual(chatModels(["text-embedding-3-small"]), ["text-embedding-3-small"]);
  });

  it("quoteEnvValue quotes only when dotenv would change the value, and round-trips", () => {
    for (const v of ["sk-abc123", "https://a.b/v1", "a b", "has#hash", "it's", "back`tick'", "x$y", 'q"uote']) {
      const line = `K=${quoteEnvValue(v)}`;
      assert.strictEqual(parseDotenv(line).K, v, line);
    }
    assert.strictEqual(quoteEnvValue("plain"), "plain");
    assert.throws(() => quoteEnvValue("a\nb"), /one line/);
    assert.throws(() => quoteEnvValue("'`\""), /cannot be written/);
  });

  it("setEnvValues replaces keys in place, adds new ones, and keeps comments and line endings", () => {
    const text = "# head\nA=1\n# export B=old\nexport B=2\n";
    assert.strictEqual(setEnvValues(text, { B: "two words", C: "3" }), "# head\nA=1\n# export B=old\nB='two words'\nC=3\n");
    assert.strictEqual(setEnvValues("A=1\r\nB=2", { A: "x" }), "A=x\r\nB=2");
    assert.strictEqual(setEnvValues("", { A: "x" }), "A=x\n");
  });

  it("setEnvValues fills the template, and dotenv reads the values back", () => {
    const out = setEnvValues(ENV_TEMPLATE, { ASSISTIVE_LLM_API_KEY: "sk-1", ASSISTIVE_LLM_MODEL: "gpt-x", ASSISTIVE_TRIAGE: "llm" });
    const vars = parseDotenv(out);
    assert.strictEqual(vars.ASSISTIVE_LLM_API_KEY, "sk-1");
    assert.strictEqual(vars.ASSISTIVE_LLM_MODEL, "gpt-x");
    assert.strictEqual(vars.ASSISTIVE_TRIAGE, "llm");
    assert.strictEqual(out.split("\n").length, ENV_TEMPLATE.split("\n").length, "no line was added");
  });

  describe("listModels", () => {
    let fake: FakeServers;
    before(async () => (fake = await new FakeServers().start()));
    after(async () => fake.stop());

    it("reads the model IDs with the key and the extra headers", async () => {
      fake.models = ["m-1", "m-2"];
      assert.deepStrictEqual(await listModels(`${fake.base}/v1/`, "sk-test", { headers: { "X-Title": "Assistive" } }), ["m-1", "m-2"]);
      assert.strictEqual(fake.modelRequests.at(-1)?.authorization, "Bearer sk-test");
      assert.strictEqual(fake.modelRequests.at(-1)?.title, "Assistive");
    });

    it("fails with the HTTP status, or when the answer has no list", async () => {
      fake.models = 401;
      await assert.rejects(listModels(`${fake.base}/v1`, "bad"), /HTTP 401/);
      fake.models = "not a list";
      await assert.rejects(listModels(`${fake.base}/v1`, "k"), /no model list/);
    });
  });
});
