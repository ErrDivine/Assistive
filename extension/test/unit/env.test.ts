import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseDotenv } from "dotenv";
import {
  DEFAULT_HEARTBEAT_SECONDS,
  ENV_TEMPLATE,
  ensureEnvFile,
  envCandidates,
  isPlaceholder,
  loadConfig,
  MIN_HEARTBEAT_SECONDS,
  parseConfig,
} from "../../src/config/env";

const tempDirs: string[] = [];

/** A fresh temp directory (resolved through realpath so path comparisons survive symlinked tmpdirs). */
function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "assistive-env-")));
  tempDirs.push(dir);
  return dir;
}

/** An extension folder whose parent holds no .env or .env.example. */
function isolatedExt(): string {
  const ext = path.join(tempDir(), "extension");
  fs.mkdirSync(ext);
  return ext;
}

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** Variables that make both services "ready". */
const READY = {
  ASSISTIVE_LLM_API_KEY: "sk-real-key",
  ASSISTIVE_LLM_MODEL: "gpt-test",
  ASSISTIVE_JEV_API_KEY: "jev-real-key",
};

const LLM_PROBLEM = "Set ASSISTIVE_LLM_API_KEY and ASSISTIVE_LLM_MODEL to use the assistant.";
const JEV_PROBLEM = "Set ASSISTIVE_JEV_API_KEY for heartbeat triage (or set ASSISTIVE_TRIAGE=llm).";

// ---------------------------------------------------------------- isPlaceholder

describe("isPlaceholder", () => {
  it("treats missing and blank values as placeholders", () => {
    assert.strictEqual(isPlaceholder(undefined), true);
    assert.strictEqual(isPlaceholder(""), true);
    assert.strictEqual(isPlaceholder("   "), true);
    assert.strictEqual(isPlaceholder("\t\n"), true);
  });

  it("recognizes REPLACE_ME in its spellings", () => {
    for (const v of ["REPLACE_ME", "replace_me", "REPLACE-ME", "REPLACEME", "Replace_Me", "  REPLACE_ME  ", "sk-REPLACE_ME-123"]) {
      assert.strictEqual(isPlaceholder(v), true, v);
    }
  });

  it("recognizes YOUR_ / YOUR- style placeholders", () => {
    for (const v of ["YOUR_API_KEY", "your-api-key", "YOUR_KEY_HERE", "sk-your_key"]) {
      assert.strictEqual(isPlaceholder(v), true, v);
    }
  });

  it("recognizes <angle bracket> placeholders", () => {
    assert.strictEqual(isPlaceholder("<api key>"), true);
    assert.strictEqual(isPlaceholder("<your-key>"), true);
    assert.strictEqual(isPlaceholder("<>"), true);
  });

  it("recognizes runs of x", () => {
    for (const v of ["x", "xxxx", "XXXXXXXX", " xxx "]) {
      assert.strictEqual(isPlaceholder(v), true, v);
    }
  });

  it("accepts real-looking values", () => {
    for (const v of ["sk-abc123", "gpt-4o", "jev-latest", "claude-sonnet", "xyz", "sk-xxxx-real", "a1b2c3", "https://example.com"]) {
      assert.strictEqual(isPlaceholder(v), false, v);
    }
  });
});

// ---------------------------------------------------------------- parseConfig

describe("parseConfig defaults", () => {
  const cfg = parseConfig({});

  it("fills in the documented defaults", () => {
    assert.deepStrictEqual(cfg.llm, {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "",
      temperature: 0.2,
      timeoutMs: 120_000,
      maxToolRounds: 8,
      extraHeaders: {},
      extraBody: {},
      stream: true,
    });
    assert.deepStrictEqual(cfg.jev, { baseUrl: "https://api.typesafe.ai/v1", apiKey: "", model: "jev-latest", timeoutMs: 10_000 });
    assert.strictEqual(cfg.triage, "jev");
    assert.deepStrictEqual(cfg.heartbeat, {
      intervalMs: 45_000,
      interruptThreshold: 0.65,
      cooldownMs: 90_000,
      graphSyncThreshold: 0.7,
      explainThreshold: 0.75,
    });
    assert.strictEqual(cfg.verifyLinks, true);
  });

  it("is not ready and says what to set", () => {
    assert.strictEqual(cfg.llmReady, false);
    assert.strictEqual(cfg.jevReady, false);
    assert.deepStrictEqual(cfg.problems, [LLM_PROBLEM, JEV_PROBLEM]);
    assert.strictEqual(cfg.source, undefined);
  });

  it("exports the heartbeat constants it uses", () => {
    assert.strictEqual(MIN_HEARTBEAT_SECONDS, 15);
    assert.strictEqual(DEFAULT_HEARTBEAT_SECONDS, 45);
  });

  it("records the source file", () => {
    assert.strictEqual(parseConfig({}, "/some/.env").source, "/some/.env");
  });

  it("reads explicit values", () => {
    const c = parseConfig({
      ...READY,
      ASSISTIVE_LLM_BASE_URL: "http://localhost:11434/v1",
      ASSISTIVE_LLM_TEMPERATURE: "0.7",
      ASSISTIVE_LLM_TIMEOUT_SECONDS: "60",
      ASSISTIVE_LLM_MAX_TOOL_ROUNDS: "5",
      ASSISTIVE_LLM_STREAM: "off",
      ASSISTIVE_JEV_BASE_URL: "https://jev.example/v1",
      ASSISTIVE_JEV_MODEL: "jev-2",
      ASSISTIVE_JEV_TIMEOUT_SECONDS: "20",
      ASSISTIVE_TRIAGE: "llm",
      ASSISTIVE_HEARTBEAT_SECONDS: "30",
      ASSISTIVE_INTERRUPT_THRESHOLD: "0.5",
      ASSISTIVE_INTERRUPT_COOLDOWN_SECONDS: "10",
      ASSISTIVE_GRAPH_SYNC_THRESHOLD: "0.9",
      ASSISTIVE_EXPLAIN_THRESHOLD: "0.8",
    });
    assert.deepStrictEqual(c.llm, {
      baseUrl: "http://localhost:11434/v1",
      apiKey: "sk-real-key",
      model: "gpt-test",
      temperature: 0.7,
      timeoutMs: 60_000,
      maxToolRounds: 5,
      extraHeaders: {},
      extraBody: {},
      stream: false,
    });
    assert.deepStrictEqual(c.jev, { baseUrl: "https://jev.example/v1", apiKey: "jev-real-key", model: "jev-2", timeoutMs: 20_000 });
    assert.strictEqual(c.triage, "llm");
    assert.deepStrictEqual(c.heartbeat, {
      intervalMs: 30_000,
      interruptThreshold: 0.5,
      cooldownMs: 10_000,
      graphSyncThreshold: 0.9,
      explainThreshold: 0.8,
    });
    assert.deepStrictEqual(c.problems, []);
  });

  it("trims whitespace around values", () => {
    const c = parseConfig({ ASSISTIVE_LLM_API_KEY: "  sk-real  ", ASSISTIVE_LLM_MODEL: " gpt-test ", ASSISTIVE_JEV_MODEL: "  jev-3  " });
    assert.strictEqual(c.llm.apiKey, "sk-real");
    assert.strictEqual(c.llm.model, "gpt-test");
    assert.strictEqual(c.jev.model, "jev-3");
  });

  it("an explicit zero is kept, not replaced by the default", () => {
    const c = parseConfig({ ASSISTIVE_LLM_TEMPERATURE: "0", ASSISTIVE_INTERRUPT_COOLDOWN_SECONDS: "0", ASSISTIVE_INTERRUPT_THRESHOLD: "0" });
    assert.strictEqual(c.llm.temperature, 0);
    assert.strictEqual(c.heartbeat.cooldownMs, 0);
    assert.strictEqual(c.heartbeat.interruptThreshold, 0);
    assert.ok(!c.problems.some((p) => /out of range|not a number/.test(p)), c.problems.join("\n"));
  });

  it("falls back to the default Jev model when it is blank", () => {
    assert.strictEqual(parseConfig({ ASSISTIVE_JEV_MODEL: "" }).jev.model, "jev-latest");
    assert.strictEqual(parseConfig({ ASSISTIVE_JEV_MODEL: "   " }).jev.model, "jev-latest");
  });

  it("blank numeric values silently use the default", () => {
    const c = parseConfig({
      ...READY,
      ASSISTIVE_LLM_TEMPERATURE: "",
      ASSISTIVE_HEARTBEAT_SECONDS: "   ",
      ASSISTIVE_LLM_TIMEOUT_SECONDS: "",
    });
    assert.strictEqual(c.llm.temperature, 0.2);
    assert.strictEqual(c.heartbeat.intervalMs, 45_000);
    assert.strictEqual(c.llm.timeoutMs, 120_000);
    assert.deepStrictEqual(c.problems, []);
  });

  it("a blank base URL falls back to the default", () => {
    const c = parseConfig({ ...READY, ASSISTIVE_LLM_BASE_URL: "" });
    assert.strictEqual(c.llm.baseUrl, "https://api.openai.com/v1");
    assert.strictEqual(c.llmReady, true);
  });
});

describe("parseConfig numeric validation", () => {
  const cases: { key: string; low: string; high: string; lowUsed: string; highUsed: string; read: (c: ReturnType<typeof parseConfig>) => number }[] = [
    { key: "ASSISTIVE_LLM_TEMPERATURE", low: "-1", high: "5", lowUsed: "0", highUsed: "2", read: (c) => c.llm.temperature },
    { key: "ASSISTIVE_LLM_TIMEOUT_SECONDS", low: "1", high: "99999", lowUsed: "5", highUsed: "900", read: (c) => c.llm.timeoutMs / 1000 },
    { key: "ASSISTIVE_LLM_MAX_TOOL_ROUNDS", low: "0", high: "100", lowUsed: "1", highUsed: "30", read: (c) => c.llm.maxToolRounds },
    { key: "ASSISTIVE_JEV_TIMEOUT_SECONDS", low: "0", high: "500", lowUsed: "1", highUsed: "120", read: (c) => c.jev.timeoutMs / 1000 },
    { key: "ASSISTIVE_HEARTBEAT_SECONDS", low: "3", high: "99999", lowUsed: "15", highUsed: "3600", read: (c) => c.heartbeat.intervalMs / 1000 },
    { key: "ASSISTIVE_INTERRUPT_THRESHOLD", low: "-0.5", high: "1.5", lowUsed: "0", highUsed: "1", read: (c) => c.heartbeat.interruptThreshold },
    { key: "ASSISTIVE_INTERRUPT_COOLDOWN_SECONDS", low: "-30", high: "99999", lowUsed: "0", highUsed: "3600", read: (c) => c.heartbeat.cooldownMs / 1000 },
    { key: "ASSISTIVE_GRAPH_SYNC_THRESHOLD", low: "-1", high: "2", lowUsed: "0", highUsed: "1", read: (c) => c.heartbeat.graphSyncThreshold },
    { key: "ASSISTIVE_EXPLAIN_THRESHOLD", low: "-1", high: "7", lowUsed: "0", highUsed: "1", read: (c) => c.heartbeat.explainThreshold },
  ];

  for (const c of cases) {
    it(`${c.key}: clamps out-of-range values and says so`, () => {
      const low = parseConfig({ ...READY, [c.key]: c.low });
      assert.strictEqual(c.read(low), Number(c.lowUsed));
      assert.deepStrictEqual(low.problems, [`${c.key}=${c.low} is out of range; using ${c.lowUsed}.`]);

      const high = parseConfig({ ...READY, [c.key]: c.high });
      assert.strictEqual(c.read(high), Number(c.highUsed));
      assert.deepStrictEqual(high.problems, [`${c.key}=${c.high} is out of range; using ${c.highUsed}.`]);
    });

    it(`${c.key}: a non-number falls back to the default and says so`, () => {
      const bad = parseConfig({ ...READY, [c.key]: "banana" });
      const dflt = parseConfig({ ...READY });
      assert.strictEqual(c.read(bad), c.read(dflt));
      assert.strictEqual(bad.problems.length, 1);
      assert.match(bad.problems[0], new RegExp(`^${c.key}=banana is not a number; using [\\d.]+\\.$`));
    });
  }

  it("boundary values are accepted without a problem", () => {
    const c = parseConfig({
      ...READY,
      ASSISTIVE_LLM_TEMPERATURE: "2",
      ASSISTIVE_LLM_TIMEOUT_SECONDS: "5",
      ASSISTIVE_LLM_MAX_TOOL_ROUNDS: "30",
      ASSISTIVE_HEARTBEAT_SECONDS: "15",
      ASSISTIVE_INTERRUPT_THRESHOLD: "1",
    });
    assert.deepStrictEqual(c.problems, []);
    assert.strictEqual(c.llm.temperature, 2);
    assert.strictEqual(c.llm.timeoutMs, 5000);
    assert.strictEqual(c.llm.maxToolRounds, 30);
    assert.strictEqual(c.heartbeat.intervalMs, 15_000);
  });

  it("the not-a-number message reports the default in the setting's own unit (seconds)", () => {
    assert.deepStrictEqual(parseConfig({ ...READY, ASSISTIVE_LLM_TIMEOUT_SECONDS: "soon" }).problems, [
      "ASSISTIVE_LLM_TIMEOUT_SECONDS=soon is not a number; using 120.",
    ]);
    assert.deepStrictEqual(parseConfig({ ...READY, ASSISTIVE_HEARTBEAT_SECONDS: "often" }).problems, [
      "ASSISTIVE_HEARTBEAT_SECONDS=often is not a number; using 45.",
    ]);
  });

  it("Infinity and NaN are not numbers", () => {
    assert.match(parseConfig({ ...READY, ASSISTIVE_LLM_TEMPERATURE: "Infinity" }).problems[0], /is not a number; using 0\.2\./);
    assert.match(parseConfig({ ...READY, ASSISTIVE_LLM_TEMPERATURE: "NaN" }).problems[0], /is not a number; using 0\.2\./);
  });

  it("rounds the tool rounds to an integer", () => {
    assert.strictEqual(parseConfig({ ASSISTIVE_LLM_MAX_TOOL_ROUNDS: "2.6" }).llm.maxToolRounds, 3);
    assert.strictEqual(parseConfig({ ASSISTIVE_LLM_MAX_TOOL_ROUNDS: "2.4" }).llm.maxToolRounds, 2);
  });

  it("accepts fractional seconds", () => {
    assert.strictEqual(parseConfig({ ASSISTIVE_HEARTBEAT_SECONDS: "20.5" }).heartbeat.intervalMs, 20_500);
  });

  it("the heartbeat interval can never be below 15 seconds", () => {
    for (const raw of ["0", "1", "14", "14.9", "-100"]) {
      assert.strictEqual(parseConfig({ ASSISTIVE_HEARTBEAT_SECONDS: raw }).heartbeat.intervalMs, 15_000, raw);
    }
    assert.strictEqual(parseConfig({ ASSISTIVE_HEARTBEAT_SECONDS: "15" }).heartbeat.intervalMs, 15_000);
    assert.strictEqual(parseConfig({ ASSISTIVE_HEARTBEAT_SECONDS: "16" }).heartbeat.intervalMs, 16_000);
  });

  it("reports one problem per bad setting", () => {
    const c = parseConfig({
      ...READY,
      ASSISTIVE_LLM_TEMPERATURE: "9",
      ASSISTIVE_INTERRUPT_THRESHOLD: "high",
      ASSISTIVE_HEARTBEAT_SECONDS: "1",
    });
    assert.deepStrictEqual(c.problems, [
      "ASSISTIVE_LLM_TEMPERATURE=9 is out of range; using 2.",
      "ASSISTIVE_HEARTBEAT_SECONDS=1 is out of range; using 15.",
      "ASSISTIVE_INTERRUPT_THRESHOLD=high is not a number; using 0.65.",
    ]);
  });
});

describe("parseConfig extra headers", () => {
  const key = "ASSISTIVE_LLM_EXTRA_HEADERS";

  it("parses a JSON object", () => {
    const c = parseConfig({ ...READY, [key]: '{"HTTP-Referer":"https://example.com","X-Title":"Assistive"}' });
    assert.deepStrictEqual(c.llm.extraHeaders, { "HTTP-Referer": "https://example.com", "X-Title": "Assistive" });
    assert.deepStrictEqual(c.problems, []);
  });

  it("stringifies non-string values", () => {
    const c = parseConfig({ ...READY, [key]: '{"X-Retries":3,"X-Flag":true,"X-Null":null}' });
    assert.deepStrictEqual(c.llm.extraHeaders, { "X-Retries": "3", "X-Flag": "true", "X-Null": "null" });
  });

  it("is empty when unset, blank or whitespace", () => {
    for (const v of [undefined, "", "   "]) {
      const vars: Record<string, string> = { ...READY };
      if (v !== undefined) vars[key] = v;
      const c = parseConfig(vars);
      assert.deepStrictEqual(c.llm.extraHeaders, {});
      assert.deepStrictEqual(c.problems, []);
    }
  });

  it("an empty object is fine", () => {
    const c = parseConfig({ ...READY, [key]: "{}" });
    assert.deepStrictEqual(c.llm.extraHeaders, {});
    assert.deepStrictEqual(c.problems, []);
  });

  it("an array is a problem and is ignored", () => {
    const c = parseConfig({ ...READY, [key]: '["a","b"]' });
    assert.deepStrictEqual(c.llm.extraHeaders, {});
    assert.deepStrictEqual(c.problems, ["ASSISTIVE_LLM_EXTRA_HEADERS must be a JSON object."]);
  });

  it("other JSON values (string, number, null) are problems too", () => {
    for (const v of ['"text"', "42", "null", "true"]) {
      const c = parseConfig({ ...READY, [key]: v });
      assert.deepStrictEqual(c.llm.extraHeaders, {}, v);
      assert.deepStrictEqual(c.problems, ["ASSISTIVE_LLM_EXTRA_HEADERS must be a JSON object."], v);
    }
  });

  it("invalid JSON is a problem and is ignored", () => {
    for (const v of ["{not json}", "{'single': 'quotes'}", '{"a":', "HTTP-Referer: x"]) {
      const c = parseConfig({ ...READY, [key]: v });
      assert.deepStrictEqual(c.llm.extraHeaders, {}, v);
      assert.deepStrictEqual(c.problems, ["ASSISTIVE_LLM_EXTRA_HEADERS is not valid JSON."], v);
    }
  });
});

describe("parseConfig triage", () => {
  it("accepts jev, llm and off", () => {
    for (const t of ["jev", "llm", "off"] as const) {
      assert.strictEqual(parseConfig({ ...READY, ASSISTIVE_TRIAGE: t }).triage, t);
    }
  });

  it("is case-insensitive and ignores surrounding space", () => {
    assert.strictEqual(parseConfig({ ...READY, ASSISTIVE_TRIAGE: "LLM" }).triage, "llm");
    assert.strictEqual(parseConfig({ ...READY, ASSISTIVE_TRIAGE: " Off " }).triage, "off");
    assert.strictEqual(parseConfig({ ...READY, ASSISTIVE_TRIAGE: "JEV" }).triage, "jev");
  });

  it("defaults to jev", () => {
    assert.strictEqual(parseConfig({ ...READY }).triage, "jev");
  });

  it("an invalid value falls back to jev with a problem (lowercased in the message)", () => {
    const c = parseConfig({ ...READY, ASSISTIVE_TRIAGE: "Robot" });
    assert.strictEqual(c.triage, "jev");
    assert.deepStrictEqual(c.problems, ["ASSISTIVE_TRIAGE=robot is not one of jev, llm, off; using jev."]);
  });
});

describe("parseConfig verifyLinks", () => {
  for (const v of ["false", "0", "no", "off", "FALSE", "Off", "No", " false ", "\tOFF\n"]) {
    it(`ASSISTIVE_VERIFY_LINKS=${JSON.stringify(v)} turns checking off`, () => {
      assert.strictEqual(parseConfig({ ASSISTIVE_VERIFY_LINKS: v }).verifyLinks, false);
    });
  }

  for (const v of ["true", "1", "yes", "on", "TRUE", "", "maybe", "falsey", "nope", "00"]) {
    it(`ASSISTIVE_VERIFY_LINKS=${JSON.stringify(v)} keeps checking on`, () => {
      assert.strictEqual(parseConfig({ ASSISTIVE_VERIFY_LINKS: v }).verifyLinks, true);
    });
  }

  it("is on when unset", () => {
    assert.strictEqual(parseConfig({}).verifyLinks, true);
  });
});

describe("parseConfig base URLs", () => {
  it("trims trailing slashes", () => {
    assert.strictEqual(parseConfig({ ASSISTIVE_LLM_BASE_URL: "https://api.example.com/v1/" }).llm.baseUrl, "https://api.example.com/v1");
    assert.strictEqual(parseConfig({ ASSISTIVE_LLM_BASE_URL: "https://api.example.com/v1///" }).llm.baseUrl, "https://api.example.com/v1");
    assert.strictEqual(parseConfig({ ASSISTIVE_JEV_BASE_URL: "https://jev.example.com/v1/" }).jev.baseUrl, "https://jev.example.com/v1");
  });

  it("trims whitespace around the URL as well", () => {
    assert.strictEqual(parseConfig({ ASSISTIVE_LLM_BASE_URL: "  https://api.example.com/v1/  " }).llm.baseUrl, "https://api.example.com/v1");
  });

  it("leaves a URL without a trailing slash alone and keeps inner slashes", () => {
    assert.strictEqual(parseConfig({ ASSISTIVE_LLM_BASE_URL: "http://localhost:8080/openai/v1" }).llm.baseUrl, "http://localhost:8080/openai/v1");
  });
});

describe("parseConfig readiness", () => {
  it("is ready with real keys and the default URLs", () => {
    const c = parseConfig(READY);
    assert.strictEqual(c.llmReady, true);
    assert.strictEqual(c.jevReady, true);
    assert.deepStrictEqual(c.problems, []);
  });

  it("llm is not ready with a placeholder or missing key", () => {
    for (const apiKey of ["REPLACE_ME", "YOUR_API_KEY", "", "<key>"]) {
      const c = parseConfig({ ...READY, ASSISTIVE_LLM_API_KEY: apiKey });
      assert.strictEqual(c.llmReady, false, apiKey);
      assert.ok(c.problems.includes(LLM_PROBLEM), apiKey);
    }
  });

  it("llm is not ready with a placeholder or missing model", () => {
    for (const model of ["REPLACE_ME", "", "your-model-name"]) {
      const c = parseConfig({ ...READY, ASSISTIVE_LLM_MODEL: model });
      assert.strictEqual(c.llmReady, false, model);
      assert.ok(c.problems.includes(LLM_PROBLEM), model);
    }
  });

  it("llm needs an http(s) base URL", () => {
    assert.strictEqual(parseConfig({ ...READY, ASSISTIVE_LLM_BASE_URL: "api.openai.com/v1" }).llmReady, false);
    assert.strictEqual(parseConfig({ ...READY, ASSISTIVE_LLM_BASE_URL: "ftp://example.com" }).llmReady, false);
    assert.strictEqual(parseConfig({ ...READY, ASSISTIVE_LLM_BASE_URL: "http://localhost:11434/v1" }).llmReady, true);
    assert.strictEqual(parseConfig({ ...READY, ASSISTIVE_LLM_BASE_URL: "HTTPS://example.com" }).llmReady, false, "the scheme check is case-sensitive");
  });

  it("jev is ready with a real key and does not need a model", () => {
    const c = parseConfig({ ASSISTIVE_JEV_API_KEY: "real", ASSISTIVE_JEV_MODEL: "REPLACE_ME" });
    assert.strictEqual(c.jevReady, true);
  });

  it("jev is not ready with a placeholder or missing key", () => {
    for (const apiKey of ["REPLACE_ME", "", "xxxx"]) {
      const c = parseConfig({ ...READY, ASSISTIVE_JEV_API_KEY: apiKey });
      assert.strictEqual(c.jevReady, false, apiKey);
      assert.ok(c.problems.includes(JEV_PROBLEM), apiKey);
    }
  });

  it("jev needs an http(s) base URL", () => {
    assert.strictEqual(parseConfig({ ...READY, ASSISTIVE_JEV_BASE_URL: "jev.example.com" }).jevReady, false);
    assert.strictEqual(parseConfig({ ...READY, ASSISTIVE_JEV_BASE_URL: "http://127.0.0.1:9000" }).jevReady, true);
  });

  it("the Jev problem only appears when triage is jev", () => {
    const noJev = { ASSISTIVE_LLM_API_KEY: "sk-real", ASSISTIVE_LLM_MODEL: "m" };
    assert.deepStrictEqual(parseConfig({ ...noJev, ASSISTIVE_TRIAGE: "jev" }).problems, [JEV_PROBLEM]);
    assert.deepStrictEqual(parseConfig({ ...noJev, ASSISTIVE_TRIAGE: "llm" }).problems, []);
    assert.deepStrictEqual(parseConfig({ ...noJev, ASSISTIVE_TRIAGE: "off" }).problems, []);
  });

  it("the LLM problem appears regardless of the triage mode", () => {
    for (const t of ["jev", "llm", "off"]) {
      const c = parseConfig({ ASSISTIVE_JEV_API_KEY: "real", ASSISTIVE_TRIAGE: t });
      assert.ok(c.problems.includes(LLM_PROBLEM), t);
    }
  });

  it("lists the readiness problems after the value problems", () => {
    const c = parseConfig({ ASSISTIVE_LLM_TEMPERATURE: "9" });
    assert.deepStrictEqual(c.problems, ["ASSISTIVE_LLM_TEMPERATURE=9 is out of range; using 2.", LLM_PROBLEM, JEV_PROBLEM]);
  });
});

describe("ENV_TEMPLATE", () => {
  const vars = parseDotenv(ENV_TEMPLATE);

  it("lists every setting parseConfig reads", () => {
    for (const key of [
      "ASSISTIVE_LLM_BASE_URL",
      "ASSISTIVE_LLM_API_KEY",
      "ASSISTIVE_LLM_MODEL",
      "ASSISTIVE_LLM_TEMPERATURE",
      "ASSISTIVE_LLM_TIMEOUT_SECONDS",
      "ASSISTIVE_LLM_MAX_TOOL_ROUNDS",
      "ASSISTIVE_LLM_EXTRA_HEADERS",
      "ASSISTIVE_JEV_BASE_URL",
      "ASSISTIVE_JEV_API_KEY",
      "ASSISTIVE_JEV_MODEL",
      "ASSISTIVE_JEV_TIMEOUT_SECONDS",
      "ASSISTIVE_TRIAGE",
      "ASSISTIVE_HEARTBEAT_SECONDS",
      "ASSISTIVE_INTERRUPT_THRESHOLD",
      "ASSISTIVE_INTERRUPT_COOLDOWN_SECONDS",
      "ASSISTIVE_GRAPH_SYNC_THRESHOLD",
      "ASSISTIVE_EXPLAIN_THRESHOLD",
      "ASSISTIVE_VERIFY_LINKS",
    ]) {
      assert.ok(key in vars, `${key} missing from the template`);
    }
  });

  it("parses to exactly the built-in defaults, apart from the placeholders, with only the two 'fill me in' problems", () => {
    const fromTemplate = parseConfig(vars);
    assert.deepStrictEqual(fromTemplate.problems, [LLM_PROBLEM, JEV_PROBLEM]);
    const blanked = parseConfig({ ...vars, ASSISTIVE_LLM_API_KEY: "", ASSISTIVE_LLM_MODEL: "", ASSISTIVE_JEV_API_KEY: "" });
    assert.deepStrictEqual(blanked, parseConfig({}));
  });

  it("ships placeholders for the secrets", () => {
    assert.ok(isPlaceholder(vars.ASSISTIVE_LLM_API_KEY));
    assert.ok(isPlaceholder(vars.ASSISTIVE_LLM_MODEL));
    assert.ok(isPlaceholder(vars.ASSISTIVE_JEV_API_KEY));
  });
});

// ---------------------------------------------------------------- envCandidates

describe("envCandidates", () => {
  it("is just ~/.assistive/.env when there is no setting and no repo", () => {
    const home = tempDir();
    const ext = isolatedExt();
    assert.deepStrictEqual(envCandidates(undefined, ext, home), [path.join(home, ".assistive", ".env")]);
  });

  it("puts the setting first, resolved to an absolute path", () => {
    const home = tempDir();
    const ext = isolatedExt();
    const abs = path.join(tempDir(), "custom", ".env");
    assert.deepStrictEqual(envCandidates(abs, ext, home), [abs, path.join(home, ".assistive", ".env")]);
  });

  it("expands ~ in the setting using the home parameter", () => {
    const home = tempDir();
    const ext = isolatedExt();
    assert.strictEqual(envCandidates("~/secrets/assistive.env", ext, home)[0], path.join(home, "secrets", "assistive.env"));
    assert.strictEqual(envCandidates("~", ext, home)[0], home);
    assert.strictEqual(envCandidates("~\\win\\.env", ext, home)[0], path.resolve(home + "\\win\\.env"));
  });

  it("does not expand a ~ that is not at the start or is part of a name", () => {
    const home = tempDir();
    const ext = isolatedExt();
    assert.strictEqual(envCandidates("/etc/~/x", ext, home)[0], path.resolve("/etc/~/x"));
    assert.strictEqual(envCandidates("~bob/x", ext, home)[0], path.resolve("~bob/x"));
  });

  it("trims the setting and ignores a blank one", () => {
    const home = tempDir();
    const ext = isolatedExt();
    const abs = path.join(tempDir(), ".env");
    assert.strictEqual(envCandidates(`  ${abs}  `, ext, home)[0], abs);
    for (const blank of [undefined, "", "   "]) {
      assert.deepStrictEqual(envCandidates(blank, ext, home), [path.join(home, ".assistive", ".env")], JSON.stringify(blank));
    }
  });

  it("resolves a relative setting against the working directory", () => {
    const home = tempDir();
    const ext = isolatedExt();
    assert.strictEqual(envCandidates("conf/assistive.env", ext, home)[0], path.resolve("conf/assistive.env"));
  });

  it("includes <repo>/.env when .env.example sits next to the extension folder", () => {
    const repo = tempDir();
    const ext = path.join(repo, "extension");
    fs.mkdirSync(ext);
    fs.writeFileSync(path.join(repo, ".env.example"), "");
    const home = tempDir();
    assert.deepStrictEqual(envCandidates(undefined, ext, home), [path.join(repo, ".env"), path.join(home, ".assistive", ".env")]);
  });

  it("includes <repo>/.env when only a .env exists there", () => {
    const repo = tempDir();
    const ext = path.join(repo, "extension");
    fs.mkdirSync(ext);
    fs.writeFileSync(path.join(repo, ".env"), "");
    const home = tempDir();
    assert.deepStrictEqual(envCandidates(undefined, ext, home), [path.join(repo, ".env"), path.join(home, ".assistive", ".env")]);
  });

  it("omits the repo .env when neither .env nor .env.example exists there", () => {
    const repo = tempDir();
    const ext = path.join(repo, "extension");
    fs.mkdirSync(ext);
    fs.writeFileSync(path.join(repo, "README.md"), "");
    const home = tempDir();
    assert.deepStrictEqual(envCandidates(undefined, ext, home), [path.join(home, ".assistive", ".env")]);
  });

  it("orders setting, repo, home", () => {
    const repo = tempDir();
    const ext = path.join(repo, "extension");
    fs.mkdirSync(ext);
    fs.writeFileSync(path.join(repo, ".env.example"), "");
    const home = tempDir();
    const setting = path.join(tempDir(), "mine.env");
    assert.deepStrictEqual(envCandidates(setting, ext, home), [setting, path.join(repo, ".env"), path.join(home, ".assistive", ".env")]);
  });

  it("follows a symlinked extension folder back to the source checkout", function () {
    if (process.platform === "win32") this.skip();
    const repo = tempDir();
    const ext = path.join(repo, "extension");
    fs.mkdirSync(ext);
    fs.writeFileSync(path.join(repo, ".env.example"), "");
    const installed = tempDir(); // e.g. ~/.vscode/extensions: no .env.example in here
    const link = path.join(installed, "assistive");
    fs.symlinkSync(ext, link, "dir");
    const home = tempDir();
    assert.deepStrictEqual(envCandidates(undefined, link, home), [path.join(repo, ".env"), path.join(home, ".assistive", ".env")]);
  });

  it("copes with an extension path that does not exist", () => {
    const home = tempDir();
    const missing = path.join(tempDir(), "no", "such", "extension");
    assert.deepStrictEqual(envCandidates(undefined, missing, home), [path.join(home, ".assistive", ".env")]);
  });

  it("always ends with ~/.assistive/.env under the given home", () => {
    const home = tempDir();
    const list = envCandidates("/x/.env", tempDir(), home);
    assert.strictEqual(list[list.length - 1], path.join(home, ".assistive", ".env"));
  });
});

// ---------------------------------------------------------------- loadConfig

describe("loadConfig", () => {
  it("reads the first readable candidate and records it as the source", () => {
    const dir = tempDir();
    const a = write(path.join(dir, "a.env"), "ASSISTIVE_LLM_MODEL=model-a\nASSISTIVE_LLM_API_KEY=key-a\n");
    const b = write(path.join(dir, "b.env"), "ASSISTIVE_LLM_MODEL=model-b\n");
    const cfg = loadConfig([a, b], {});
    assert.strictEqual(cfg.llm.model, "model-a");
    assert.strictEqual(cfg.llm.apiKey, "key-a");
    assert.strictEqual(cfg.source, a);
  });

  it("skips candidates that do not exist", () => {
    const dir = tempDir();
    const real = write(path.join(dir, "real.env"), "ASSISTIVE_LLM_MODEL=from-file\n");
    const cfg = loadConfig([path.join(dir, "missing.env"), path.join(dir, "also", "missing.env"), real], {});
    assert.strictEqual(cfg.llm.model, "from-file");
    assert.strictEqual(cfg.source, real);
  });

  it("skips a candidate that cannot be read as a file (a directory)", () => {
    const dir = tempDir();
    const asDir = path.join(dir, "folder.env");
    fs.mkdirSync(asDir);
    const real = write(path.join(dir, "real.env"), "ASSISTIVE_LLM_MODEL=ok\n");
    assert.strictEqual(loadConfig([asDir, real], {}).source, real);
  });

  it("does not merge later files into the first one found", () => {
    const dir = tempDir();
    const a = write(path.join(dir, "a.env"), "ASSISTIVE_LLM_MODEL=model-a\n");
    const b = write(path.join(dir, "b.env"), "ASSISTIVE_LLM_API_KEY=key-b\n");
    const cfg = loadConfig([a, b], {});
    assert.strictEqual(cfg.llm.model, "model-a");
    assert.strictEqual(cfg.llm.apiKey, "");
  });

  it("an empty file still counts: it is used, with defaults, and later files are not consulted", () => {
    const dir = tempDir();
    const empty = write(path.join(dir, "empty.env"), "");
    const b = write(path.join(dir, "b.env"), "ASSISTIVE_LLM_MODEL=model-b\n");
    const cfg = loadConfig([empty, b], {});
    assert.strictEqual(cfg.source, empty);
    assert.strictEqual(cfg.llm.model, "");
  });

  it("falls back to defaults (no source) when no candidate is readable", () => {
    const dir = tempDir();
    const cfg = loadConfig([path.join(dir, "nope.env")], {});
    assert.strictEqual(cfg.source, undefined);
    assert.deepStrictEqual(cfg, parseConfig({}));
  });

  it("falls back to defaults for an empty candidate list", () => {
    assert.deepStrictEqual(loadConfig([], {}), parseConfig({}));
  });

  it("parses dotenv syntax: comments, quotes and JSON values", () => {
    const dir = tempDir();
    const file = write(
      path.join(dir, ".env"),
      [
        "# a comment",
        "ASSISTIVE_LLM_API_KEY=sk-from-file",
        'ASSISTIVE_LLM_MODEL="gpt with spaces"',
        "ASSISTIVE_JEV_API_KEY='jev-key'",
        'ASSISTIVE_LLM_EXTRA_HEADERS={"HTTP-Referer":"https://example.com"}',
        "ASSISTIVE_HEARTBEAT_SECONDS=30 # inline comment",
        "",
      ].join("\n"),
    );
    const cfg = loadConfig([file], {});
    assert.strictEqual(cfg.llm.apiKey, "sk-from-file");
    assert.strictEqual(cfg.llm.model, "gpt with spaces");
    assert.strictEqual(cfg.jev.apiKey, "jev-key");
    assert.deepStrictEqual(cfg.llm.extraHeaders, { "HTTP-Referer": "https://example.com" });
    assert.strictEqual(cfg.heartbeat.intervalMs, 30_000);
    assert.deepStrictEqual(cfg.problems, []);
    assert.strictEqual(cfg.llmReady && cfg.jevReady, true);
  });

  it("ASSISTIVE_* entries in the env object override the file", () => {
    const dir = tempDir();
    const file = write(path.join(dir, ".env"), "ASSISTIVE_LLM_MODEL=file-model\nASSISTIVE_LLM_API_KEY=file-key\nASSISTIVE_TRIAGE=jev\n");
    const cfg = loadConfig([file], { ASSISTIVE_LLM_MODEL: "env-model", ASSISTIVE_TRIAGE: "off" });
    assert.strictEqual(cfg.llm.model, "env-model");
    assert.strictEqual(cfg.llm.apiKey, "file-key", "unrelated file values stay");
    assert.strictEqual(cfg.triage, "off");
    assert.strictEqual(cfg.source, file);
  });

  it("ASSISTIVE_* entries can supply values the file lacks", () => {
    const dir = tempDir();
    const file = write(path.join(dir, ".env"), "ASSISTIVE_LLM_MODEL=file-model\n");
    const cfg = loadConfig([file], { ASSISTIVE_LLM_API_KEY: "env-key" });
    assert.strictEqual(cfg.llm.model, "file-model");
    assert.strictEqual(cfg.llm.apiKey, "env-key");
  });

  it("ASSISTIVE_* entries configure everything when there is no file", () => {
    const cfg = loadConfig([], { ...READY, ASSISTIVE_TRIAGE: "llm" });
    assert.strictEqual(cfg.source, undefined);
    assert.strictEqual(cfg.llmReady, true);
    assert.strictEqual(cfg.triage, "llm");
  });

  it("other environment variables are ignored", () => {
    const dir = tempDir();
    const file = write(path.join(dir, ".env"), "ASSISTIVE_LLM_MODEL=file-model\n");
    const cfg = loadConfig([file], {
      LLM_MODEL: "wrong",
      OPENAI_API_KEY: "sk-leak",
      OPENAI_BASE_URL: "http://elsewhere",
      JEV_API_KEY: "nope",
      PATH: "/usr/bin",
      assistive_llm_model: "lowercase-is-not-ours",
      XASSISTIVE_LLM_MODEL: "prefix-must-be-at-start",
    });
    assert.strictEqual(cfg.llm.model, "file-model");
    assert.strictEqual(cfg.llm.apiKey, "");
    assert.strictEqual(cfg.llm.baseUrl, "https://api.openai.com/v1");
    assert.strictEqual(cfg.jev.apiKey, "");
  });

  it("an ASSISTIVE_* entry whose value is undefined does not override the file", () => {
    const dir = tempDir();
    const file = write(path.join(dir, ".env"), "ASSISTIVE_LLM_MODEL=file-model\n");
    assert.strictEqual(loadConfig([file], { ASSISTIVE_LLM_MODEL: undefined }).llm.model, "file-model");
  });

  it("env overrides go through the same validation as file values", () => {
    const cfg = loadConfig([], { ...READY, ASSISTIVE_HEARTBEAT_SECONDS: "2" });
    assert.strictEqual(cfg.heartbeat.intervalMs, 15_000);
    assert.deepStrictEqual(cfg.problems, ["ASSISTIVE_HEARTBEAT_SECONDS=2 is out of range; using 15."]);
  });

  it("does not read process.env when an env object is passed", () => {
    const saved = process.env.ASSISTIVE_LLM_MODEL;
    process.env.ASSISTIVE_LLM_MODEL = "from-process-env";
    try {
      assert.strictEqual(loadConfig([], {}).llm.model, "");
    } finally {
      if (saved === undefined) delete process.env.ASSISTIVE_LLM_MODEL;
      else process.env.ASSISTIVE_LLM_MODEL = saved;
    }
  });

  it("works end to end with envCandidates", () => {
    const home = tempDir();
    const ext = isolatedExt();
    const settingFile = path.join(tempDir(), "setting.env");
    // Setting points at a file that does not exist yet: the home file is used.
    write(path.join(home, ".assistive", ".env"), "ASSISTIVE_LLM_MODEL=home-model\n");
    assert.strictEqual(loadConfig(envCandidates(settingFile, ext, home), {}).llm.model, "home-model");
    // Once the setting's file exists it wins.
    write(settingFile, "ASSISTIVE_LLM_MODEL=setting-model\n");
    assert.strictEqual(loadConfig(envCandidates(settingFile, ext, home), {}).llm.model, "setting-model");
  });
});

// ---------------------------------------------------------------- ensureEnvFile

describe("ensureEnvFile", () => {
  it("creates the file, and its parent folders, from the template", () => {
    const dir = tempDir();
    const file = path.join(dir, "nested", ".assistive", ".env");
    const returned = ensureEnvFile(file);
    assert.strictEqual(returned, file);
    const text = fs.readFileSync(file, "utf8");
    assert.strictEqual(text, ENV_TEMPLATE);
    assert.ok(text.includes("ASSISTIVE_LLM_API_KEY=REPLACE_ME"));
    assert.ok(text.includes("ASSISTIVE_JEV_MODEL=jev-latest"));
  });

  it("creates the file readable only by its owner (0600)", function () {
    if (process.platform === "win32") this.skip();
    const file = path.join(tempDir(), ".env");
    ensureEnvFile(file);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  });

  it("does not overwrite an existing file", () => {
    const file = write(path.join(tempDir(), ".env"), "ASSISTIVE_LLM_API_KEY=my-real-key\n");
    assert.strictEqual(ensureEnvFile(file), file);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "ASSISTIVE_LLM_API_KEY=my-real-key\n");
  });

  it("does not change the permissions of an existing file", function () {
    if (process.platform === "win32") this.skip();
    const file = write(path.join(tempDir(), ".env"), "x=1\n");
    fs.chmodSync(file, 0o644);
    ensureEnvFile(file);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o644);
  });

  it("does not overwrite an existing empty file", () => {
    const file = write(path.join(tempDir(), ".env"), "");
    ensureEnvFile(file);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "");
  });

  it("is idempotent", () => {
    const file = path.join(tempDir(), ".env");
    ensureEnvFile(file);
    fs.appendFileSync(file, "ASSISTIVE_TRIAGE=llm\n");
    ensureEnvFile(file);
    assert.ok(fs.readFileSync(file, "utf8").endsWith("ASSISTIVE_TRIAGE=llm\n"));
  });

  it("a freshly created file loads as 'not configured yet'", () => {
    const file = ensureEnvFile(path.join(tempDir(), ".env"));
    const cfg = loadConfig([file], {});
    assert.strictEqual(cfg.source, file);
    assert.strictEqual(cfg.llmReady, false);
    assert.strictEqual(cfg.jevReady, false);
    assert.deepStrictEqual(cfg.problems, [LLM_PROBLEM, JEV_PROBLEM]);
  });
});

describe("parseConfig extra body", () => {
  it("parses a JSON object and refuses fields the agent loop controls", () => {
    const c = parseConfig({ ASSISTIVE_LLM_EXTRA_BODY: '{"reasoning_effort":"low","model":"x","tools":[]}' });
    assert.deepStrictEqual(c.llm.extraBody, { reasoning_effort: "low" });
    assert.ok(c.problems.includes('ASSISTIVE_LLM_EXTRA_BODY cannot set "model"; it is ignored.'));
    assert.ok(c.problems.includes('ASSISTIVE_LLM_EXTRA_BODY cannot set "tools"; it is ignored.'));
  });

  it("reports values that are not JSON objects", () => {
    assert.ok(parseConfig({ ASSISTIVE_LLM_EXTRA_BODY: "[1]" }).problems.includes("ASSISTIVE_LLM_EXTRA_BODY must be a JSON object."));
    assert.ok(parseConfig({ ASSISTIVE_LLM_EXTRA_BODY: "{bad" }).problems.includes("ASSISTIVE_LLM_EXTRA_BODY is not valid JSON."));
    assert.deepStrictEqual(parseConfig({}).llm.extraBody, {});
  });
});

