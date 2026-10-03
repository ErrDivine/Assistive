import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { ENV_TEMPLATE, parseConfig } from "../../src/config/env";

describe(".env.example", () => {
  const file = path.resolve(__dirname, "../../../../.env.example");

  it("is the template the extension writes", () => {
    assert.strictEqual(fs.readFileSync(file, "utf8"), ENV_TEMPLATE);
  });

  it("parses to defaults with placeholders reported", async () => {
    const { parse } = await import("dotenv");
    const cfg = parseConfig(parse(ENV_TEMPLATE));
    assert.strictEqual(cfg.llmReady, false);
    assert.strictEqual(cfg.jevReady, false);
    assert.strictEqual(cfg.jev.baseUrl, "https://api.typesafe.ai/v1");
    assert.strictEqual(cfg.jev.model, "jev-latest");
    assert.strictEqual(cfg.heartbeat.intervalMs, 45_000);
    assert.deepStrictEqual(cfg.problems, [
      "Set ASSISTIVE_LLM_API_KEY and ASSISTIVE_LLM_MODEL to use the assistant.",
      "Set ASSISTIVE_JEV_API_KEY for heartbeat triage (or set ASSISTIVE_TRIAGE=llm).",
    ]);
  });
});
