import * as assert from "node:assert";
import type { HeartbeatConfig } from "../../src/config/env";
import {
  beatDue,
  type BeatTiming,
  decide,
  describeVerdict,
  EXPLAIN_COOLDOWN_MS,
  ISSUE_CRITERIA,
  JEV_QUESTIONS,
  MIN_SEVERITY,
  type PolicyState,
  reconcileInterrupts,
  SEVERITY_LEVELS,
  SYNC_COOLDOWN_MS,
  type TriageVerdict,
  URGENT_SEVERITY,
  verdictFromJev,
  verdictFromLlmJson,
} from "../../src/heartbeat/policy";
import type { JevAnswer, JevResult } from "../../src/llm/jev";
import type { FeedItem } from "../../src/types";

const CFG: HeartbeatConfig = { intervalMs: 45_000, interruptThreshold: 0.65, cooldownMs: 90_000, graphSyncThreshold: 0.7, explainThreshold: 0.75 };

/** Compare floats that come out of `1 - p` arithmetic. */
function near(actual: number, expected: number, msg?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? "value"}: expected ${expected}, got ${actual}`);
}

// ---------------------------------------------------------------- JEV_QUESTIONS

describe("JEV_QUESTIONS", () => {
  it("asks exactly the five heartbeat questions", () => {
    assert.deepStrictEqual(Object.keys(JEV_QUESTIONS).sort(), ["graph_outdated", "interrupt", "issue", "severity", "struggling"]);
  });

  it("every question has instructions", () => {
    for (const [name, q] of Object.entries(JEV_QUESTIONS)) {
      assert.ok(q.instructions.trim().length > 20, `${name} needs real instructions`);
    }
  });

  it("interrupt is a noul question with true/false criteria", () => {
    const q = JEV_QUESTIONS.interrupt;
    assert.strictEqual(q.type, "noul");
    assert.ok(q.type === "noul" && q.criteria);
    if (q.type === "noul" && q.criteria) {
      assert.deepStrictEqual(Object.keys(q.criteria).sort(), ["false", "true"]);
      assert.ok(q.criteria.true.length > 0 && q.criteria.false.length > 0);
      assert.notStrictEqual(q.criteria.true, q.criteria.false);
    }
  });

  it("issue is a choice whose criteria include 'none' but not 'other'", () => {
    const q = JEV_QUESTIONS.issue;
    assert.strictEqual(q.type, "choice");
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      assert.ok(keys.includes("none"));
      assert.ok(!keys.includes("other"));
      assert.deepStrictEqual(keys.sort(), [
        "api_misuse",
        "better_implementation",
        "deviates_from_graph",
        "logic_error",
        "missing_edge_case",
        "none",
        "security",
        "syntax",
        "typo",
      ]);
      for (const [k, v] of Object.entries(q.criteria)) {
        assert.strictEqual(typeof v, "string", k);
        assert.ok(v.length > 10, `criterion for ${k} should be descriptive`);
      }
    }
  });

  it("issue criteria come from ISSUE_CRITERIA", () => {
    const q = JEV_QUESTIONS.issue;
    assert.ok(q.type === "choice");
    if (q.type === "choice") {
      for (const [k, v] of Object.entries(q.criteria)) {
        assert.strictEqual(v, ISSUE_CRITERIA[k as keyof typeof ISSUE_CRITERIA]);
      }
    }
    assert.ok("other" in ISSUE_CRITERIA, "ISSUE_CRITERIA itself still describes 'other' for the LLM fallback");
  });

  it("severity is a score with four levels, from cosmetic to blocking", () => {
    const q = JEV_QUESTIONS.severity;
    assert.strictEqual(q.type, "score");
    if (q.type === "score") {
      assert.strictEqual(q.criteria.length, 4);
      assert.deepStrictEqual(q.criteria, SEVERITY_LEVELS);
      assert.match(q.criteria[0], /cosmetic/i);
      assert.match(q.criteria[3], /interrupt now/i);
    }
  });

  it("graph_outdated and struggling are plain noul questions", () => {
    for (const name of ["graph_outdated", "struggling"]) {
      const q = JEV_QUESTIONS[name];
      assert.strictEqual(q.type, "noul", name);
      assert.strictEqual("criteria" in q ? q.criteria : undefined, undefined, `${name} has no criteria`);
    }
  });

  it("is plain JSON (it is sent in a request body)", () => {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(JEV_QUESTIONS)), JEV_QUESTIONS);
  });

  it("the policy thresholds are ordered sensibly", () => {
    assert.strictEqual(MIN_SEVERITY, 1.5);
    assert.strictEqual(URGENT_SEVERITY, 2.5);
    assert.ok(MIN_SEVERITY < URGENT_SEVERITY);
    assert.ok(URGENT_SEVERITY <= SEVERITY_LEVELS.length - 1, "urgent severity must be reachable on a 0-3 scale");
    assert.strictEqual(SYNC_COOLDOWN_MS, 3 * 60_000);
    assert.strictEqual(EXPLAIN_COOLDOWN_MS, 5 * 60_000);
  });
});

// ---------------------------------------------------------------- verdictFromJev

function jev(answers: Record<string, JevAnswer>, latencyMs = 120): JevResult {
  return { model: "jev-latest", answers, latencyMs };
}
const noulA = (p: number): JevAnswer => ({ type: "noul", noul: p });
const choiceA = (choice: string, probabilities: Record<string, number>, confidence = probabilities[choice] ?? 0): JevAnswer => ({
  type: "choice",
  choice,
  probabilities,
  confidence,
});
const scoreA = (score: number, confidence = 0.8): JevAnswer => ({ type: "score", score, probabilities: {}, confidence });

describe("verdictFromJev", () => {
  it("maps every answer, with issueProbability = 1 - P(none)", () => {
    const v = verdictFromJev(
      jev(
        {
          interrupt: noulA(0.82),
          issue: choiceA("logic_error", { none: 0.1, logic_error: 0.7, typo: 0.2 }),
          severity: scoreA(2.4),
          graph_outdated: noulA(0.3),
          struggling: noulA(0.2),
        },
        345,
      ),
    );
    assert.strictEqual(v.source, "jev");
    assert.strictEqual(v.interrupt, 0.82);
    assert.strictEqual(v.issue, "logic_error");
    near(v.issueProbability, 0.9, "issueProbability");
    assert.strictEqual(v.severity, 2.4);
    assert.strictEqual(v.graphOutdated, 0.3);
    assert.strictEqual(v.struggling, 0.2);
    assert.strictEqual(v.latencyMs, 345);
  });

  it("the issue probability follows P(none), not the winning choice's probability", () => {
    const v = verdictFromJev(jev({ issue: choiceA("typo", { none: 0.45, typo: 0.5, syntax: 0.05 }) }));
    assert.strictEqual(v.issue, "typo");
    near(v.issueProbability, 0.55);
  });

  it("a confident 'none' gives a low issue probability", () => {
    const v = verdictFromJev(jev({ issue: choiceA("none", { none: 0.92, typo: 0.08 }) }));
    assert.strictEqual(v.issue, "none");
    near(v.issueProbability, 0.08);
  });

  it("an unknown issue becomes 'other' but keeps the probability", () => {
    const v = verdictFromJev(jev({ issue: choiceA("banana", { none: 0.25, banana: 0.75 }) }));
    assert.strictEqual(v.issue, "other");
    near(v.issueProbability, 0.75);
  });

  it("accepts every known issue name", () => {
    for (const name of Object.keys(ISSUE_CRITERIA)) {
      const v = verdictFromJev(jev({ issue: choiceA(name, { none: 0.5, [name]: 0.5 }) }));
      assert.strictEqual(v.issue, name);
    }
  });

  it("missing answers read as zeros / 'none'", () => {
    const v = verdictFromJev(jev({}, 77));
    assert.deepStrictEqual(v, {
      source: "jev",
      interrupt: 0,
      issue: "none",
      issueProbability: 0,
      severity: 0,
      graphOutdated: 0,
      struggling: 0,
      latencyMs: 77,
    });
  });

  it("only some answers present: the rest default to zero", () => {
    const v = verdictFromJev(jev({ interrupt: noulA(0.4), struggling: noulA(0.9) }));
    assert.strictEqual(v.interrupt, 0.4);
    assert.strictEqual(v.struggling, 0.9);
    assert.strictEqual(v.issue, "none");
    assert.strictEqual(v.severity, 0);
    assert.strictEqual(v.graphOutdated, 0);
  });

  it("answers of the wrong type are ignored", () => {
    const v = verdictFromJev(jev({ interrupt: scoreA(2), severity: noulA(0.9), issue: noulA(0.5), graph_outdated: choiceA("x", { x: 1 }) }));
    assert.strictEqual(v.interrupt, 0);
    assert.strictEqual(v.severity, 0);
    assert.strictEqual(v.issue, "none");
    assert.strictEqual(v.graphOutdated, 0);
  });

  it("without a 'none' probability it falls back to the answer's confidence", () => {
    const found = verdictFromJev(jev({ issue: choiceA("syntax", { syntax: 0.6, typo: 0.4 }, 0.6) }));
    assert.strictEqual(found.issue, "syntax");
    near(found.issueProbability, 0.6);

    const none = verdictFromJev(jev({ issue: choiceA("none", { typo: 0.1 }, 0.9) }));
    assert.strictEqual(none.issue, "none");
    near(none.issueProbability, 0.1);
  });

  it("clamps the issue probability into [0, 1]", () => {
    near(verdictFromJev(jev({ issue: choiceA("typo", { none: -0.5, typo: 1 }) })).issueProbability, 1);
    near(verdictFromJev(jev({ issue: choiceA("typo", { none: 1.5, typo: 0 }) })).issueProbability, 0);
    near(verdictFromJev(jev({ issue: choiceA("typo", { none: Number.NaN, typo: 0 }) })).issueProbability, 0);
  });

  it("an all-quiet result does not escalate", () => {
    const v = verdictFromJev(
      jev({
        interrupt: noulA(0.03),
        issue: choiceA("none", { none: 0.97, typo: 0.03 }),
        severity: scoreA(0.1),
        graph_outdated: noulA(0.1),
        struggling: noulA(0.05),
      }),
    );
    const d = decide(v, CFG, {}, 1_000_000, true);
    assert.deepStrictEqual(d, { escalate: false, sync: false, explain: false, reasons: [] });
  });
});

// ---------------------------------------------------------------- verdictFromLlmJson

describe("verdictFromLlmJson", () => {
  const body = '{"interrupt":0.8,"issue":"logic_error","severity":2,"graph_outdated":0.1,"struggling":0.3}';

  it("parses plain JSON", () => {
    assert.deepStrictEqual(verdictFromLlmJson(body), {
      source: "llm",
      interrupt: 0.8,
      issue: "logic_error",
      issueProbability: 1,
      severity: 2,
      graphOutdated: 0.1,
      struggling: 0.3,
    });
  });

  it("finds JSON inside prose", () => {
    const v = verdictFromLlmJson(`Sure! Here is my assessment:\n${body}\nLet me know if you need more.`);
    assert.strictEqual(v?.issue, "logic_error");
    assert.strictEqual(v?.interrupt, 0.8);
  });

  it("finds JSON inside a code fence", () => {
    const v = verdictFromLlmJson("```json\n" + body + "\n```");
    assert.strictEqual(v?.issue, "logic_error");
    assert.strictEqual(v?.severity, 2);
  });

  it("parses multi-line, indented JSON", () => {
    const v = verdictFromLlmJson('{\n  "interrupt": 0.7,\n  "issue": "typo",\n  "severity": 3,\n  "graph_outdated": 0,\n  "struggling": 0\n}');
    assert.strictEqual(v?.issue, "typo");
    assert.strictEqual(v?.severity, 3);
  });

  it("returns undefined when there is no JSON object", () => {
    for (const text of ["", "no json here", "[1, 2, 3]", "just {", "} backwards {", "interrupt: 0.9"]) {
      assert.strictEqual(verdictFromLlmJson(text), undefined, JSON.stringify(text));
    }
  });

  it("returns undefined for braces that are not valid JSON", () => {
    for (const text of ["{not json}", "{'interrupt': 0.5}", '{"interrupt": 0.5,}', "{interrupt: 0.5}"]) {
      assert.strictEqual(verdictFromLlmJson(text), undefined, text);
    }
  });

  it("'none' means no issue probability; any other issue means certainty", () => {
    assert.strictEqual(verdictFromLlmJson('{"issue":"none"}')?.issueProbability, 0);
    assert.strictEqual(verdictFromLlmJson('{"issue":"security"}')?.issueProbability, 1);
    assert.strictEqual(verdictFromLlmJson('{"issue":"other"}')?.issueProbability, 1);
  });

  it("an unknown issue becomes 'other'", () => {
    const v = verdictFromLlmJson('{"issue":"spaghetti","interrupt":0.9,"severity":2}');
    assert.strictEqual(v?.issue, "other");
    assert.strictEqual(v?.issueProbability, 1);
  });

  it("a prototype property name is not a valid issue", () => {
    const v = verdictFromLlmJson('{"issue":"constructor","interrupt":0.9,"severity":2}');
    assert.strictEqual(v?.issue, "other");
  });

  it("missing fields default to none / zero", () => {
    const v = verdictFromLlmJson("{}");
    assert.deepStrictEqual(v, {
      source: "llm",
      interrupt: 0,
      issue: "none",
      issueProbability: 0,
      severity: 0,
      graphOutdated: 0,
      struggling: 0,
    });
  });

  it("a null issue reads as none", () => {
    assert.strictEqual(verdictFromLlmJson('{"issue":null}')?.issue, "none");
  });

  it("clamps probabilities into [0, 1]", () => {
    const v = verdictFromLlmJson('{"interrupt":1.7,"graph_outdated":-0.4,"struggling":42,"issue":"typo"}');
    assert.strictEqual(v?.interrupt, 1);
    assert.strictEqual(v?.graphOutdated, 0);
    assert.strictEqual(v?.struggling, 1);
  });

  it("clamps severity into [0, 3]", () => {
    assert.strictEqual(verdictFromLlmJson('{"severity":9}')?.severity, 3);
    assert.strictEqual(verdictFromLlmJson('{"severity":-2}')?.severity, 0);
    assert.strictEqual(verdictFromLlmJson('{"severity":2.5}')?.severity, 2.5);
  });

  it("coerces numeric strings and treats non-numeric values as zero", () => {
    const v = verdictFromLlmJson('{"interrupt":"0.4","severity":"2","graph_outdated":"lots","struggling":null}');
    assert.strictEqual(v?.interrupt, 0.4);
    assert.strictEqual(v?.severity, 2);
    assert.strictEqual(v?.graphOutdated, 0);
    assert.strictEqual(v?.struggling, 0);
  });

  it("has no latency (the LLM fallback does not report one)", () => {
    assert.ok(!("latencyMs" in (verdictFromLlmJson(body) ?? {})));
  });
});

// ---------------------------------------------------------------- decide

function verdict(over: Partial<TriageVerdict> = {}): TriageVerdict {
  return {
    source: "jev",
    interrupt: 0.9,
    issue: "logic_error",
    issueProbability: 0.9,
    severity: 2,
    graphOutdated: 0,
    struggling: 0,
    ...over,
  };
}

const NOW = 10_000_000;

describe("decide: escalation", () => {
  it("escalates when interrupt, issue, issue probability and severity all qualify", () => {
    const d = decide(verdict(), CFG, {}, NOW, true);
    assert.strictEqual(d.escalate, true);
    assert.deepStrictEqual(d.reasons, ["possible logic error (p=0.90, severity 2.0)"]);
    assert.strictEqual(d.sync, false);
    assert.strictEqual(d.explain, false);
  });

  it("the reason names the issue with spaces instead of underscores", () => {
    const d = decide(verdict({ issue: "missing_edge_case", interrupt: 0.7, severity: 1.5 }), CFG, {}, NOW, true);
    assert.deepStrictEqual(d.reasons, ["possible missing edge case (p=0.70, severity 1.5)"]);
  });

  it("interrupt must reach the configured threshold (inclusive)", () => {
    assert.strictEqual(decide(verdict({ interrupt: 0.65 }), CFG, {}, NOW, true).escalate, true);
    assert.strictEqual(decide(verdict({ interrupt: 0.6499 }), CFG, {}, NOW, true).escalate, false);
    assert.strictEqual(decide(verdict({ interrupt: 0.8 }), { ...CFG, interruptThreshold: 0.9 }, {}, NOW, true).escalate, false);
    assert.strictEqual(decide(verdict({ interrupt: 0.95 }), { ...CFG, interruptThreshold: 0.9 }, {}, NOW, true).escalate, true);
  });

  it("an issue of 'none' never escalates", () => {
    assert.strictEqual(decide(verdict({ issue: "none" }), CFG, {}, NOW, true).escalate, false);
  });

  it("the issue probability must be at least 0.5", () => {
    assert.strictEqual(decide(verdict({ issueProbability: 0.5 }), CFG, {}, NOW, true).escalate, true);
    assert.strictEqual(decide(verdict({ issueProbability: 0.49 }), CFG, {}, NOW, true).escalate, false);
  });

  it("the severity must be at least 1.5", () => {
    assert.strictEqual(decide(verdict({ severity: MIN_SEVERITY }), CFG, {}, NOW, true).escalate, true);
    assert.strictEqual(decide(verdict({ severity: 1.49 }), CFG, {}, NOW, true).escalate, false);
    assert.strictEqual(decide(verdict({ severity: 0 }), CFG, {}, NOW, true).escalate, false);
  });

  it("a failed escalation leaves no reason behind", () => {
    const d = decide(verdict({ severity: 1 }), CFG, {}, NOW, true);
    assert.deepStrictEqual(d, { escalate: false, sync: false, explain: false, reasons: [] });
  });

  it("escalation does not depend on having a graph", () => {
    assert.strictEqual(decide(verdict(), CFG, {}, NOW, false).escalate, true);
  });
});

describe("decide: interrupt cooldown", () => {
  it("blocks a normal-severity interrupt inside the cooldown and says why", () => {
    const st: PolicyState = { lastInterruptAt: NOW - 30_000 };
    const d = decide(verdict({ severity: 2 }), CFG, st, NOW, true);
    assert.strictEqual(d.escalate, false);
    assert.deepStrictEqual(d.reasons, ["interrupt cooldown"]);
  });

  it("lets an urgent problem (severity >= 2.5) through the cooldown", () => {
    const st: PolicyState = { lastInterruptAt: NOW - 1_000 };
    const d = decide(verdict({ severity: URGENT_SEVERITY }), CFG, st, NOW, true);
    assert.strictEqual(d.escalate, true);
    assert.strictEqual(d.reasons.length, 1);
    assert.match(d.reasons[0], /^possible logic error/);
    assert.strictEqual(decide(verdict({ severity: 3 }), CFG, st, NOW, true).escalate, true);
  });

  it("severity just below urgent is still blocked", () => {
    const st: PolicyState = { lastInterruptAt: NOW - 1_000 };
    assert.strictEqual(decide(verdict({ severity: 2.49 }), CFG, st, NOW, true).escalate, false);
  });

  it("the cooldown ends exactly cooldownMs after the last interrupt", () => {
    assert.strictEqual(decide(verdict(), CFG, { lastInterruptAt: NOW - 89_999 }, NOW, true).escalate, false);
    assert.strictEqual(decide(verdict(), CFG, { lastInterruptAt: NOW - 90_000 }, NOW, true).escalate, true);
    assert.strictEqual(decide(verdict(), CFG, { lastInterruptAt: NOW - 3_600_000 }, NOW, true).escalate, true);
  });

  it("uses the configured cooldown", () => {
    const st: PolicyState = { lastInterruptAt: NOW - 20_000 };
    assert.strictEqual(decide(verdict(), { ...CFG, cooldownMs: 10_000 }, st, NOW, true).escalate, true);
    assert.strictEqual(decide(verdict(), { ...CFG, cooldownMs: 30_000 }, st, NOW, true).escalate, false);
    assert.strictEqual(decide(verdict(), { ...CFG, cooldownMs: 0 }, { lastInterruptAt: NOW }, NOW, true).escalate, true);
  });

  it("a last interrupt at time 0 still counts (it is not 'never')", () => {
    assert.strictEqual(decide(verdict(), CFG, { lastInterruptAt: 0 }, 1_000, true).escalate, false);
    assert.strictEqual(decide(verdict(), CFG, { lastInterruptAt: 0 }, 90_000, true).escalate, true);
  });

  it("the cooldown is only mentioned when the verdict would otherwise escalate", () => {
    const st: PolicyState = { lastInterruptAt: NOW - 1_000 };
    const d = decide(verdict({ interrupt: 0.1 }), CFG, st, NOW, true);
    assert.deepStrictEqual(d.reasons, []);
  });

  it("the sync and explain cooldowns are independent of the interrupt cooldown", () => {
    const st: PolicyState = { lastInterruptAt: NOW - 1_000 };
    const d = decide(verdict({ interrupt: 0, graphOutdated: 0.9, struggling: 0.9 }), CFG, st, NOW, true);
    assert.strictEqual(d.sync, true);
    assert.strictEqual(d.explain, true);
  });
});

describe("decide: graph sync", () => {
  it("needs a graph", () => {
    assert.strictEqual(decide(verdict({ interrupt: 0, graphOutdated: 1 }), CFG, {}, NOW, false).sync, false);
    assert.strictEqual(decide(verdict({ interrupt: 0, graphOutdated: 1 }), CFG, {}, NOW, true).sync, true);
  });

  it("needs graphOutdated at the threshold (inclusive)", () => {
    const quiet = { interrupt: 0 };
    assert.strictEqual(decide(verdict({ ...quiet, graphOutdated: 0.7 }), CFG, {}, NOW, true).sync, true);
    assert.strictEqual(decide(verdict({ ...quiet, graphOutdated: 0.69 }), CFG, {}, NOW, true).sync, false);
    assert.strictEqual(decide(verdict({ ...quiet, graphOutdated: 0.8 }), { ...CFG, graphSyncThreshold: 0.9 }, {}, NOW, true).sync, false);
  });

  it("has a three minute cooldown", () => {
    const v = verdict({ interrupt: 0, graphOutdated: 0.95 });
    assert.strictEqual(decide(v, CFG, { lastSyncAt: NOW - (SYNC_COOLDOWN_MS - 1) }, NOW, true).sync, false);
    assert.strictEqual(decide(v, CFG, { lastSyncAt: NOW - SYNC_COOLDOWN_MS }, NOW, true).sync, true);
    assert.strictEqual(decide(v, CFG, { lastSyncAt: NOW - 60_000 }, NOW, true).sync, false);
    assert.strictEqual(decide(v, CFG, { lastSyncAt: NOW - 10 * 60_000 }, NOW, true).sync, true);
  });

  it("a last sync at time 0 still counts", () => {
    const v = verdict({ interrupt: 0, graphOutdated: 0.95 });
    assert.strictEqual(decide(v, CFG, { lastSyncAt: 0 }, 60_000, true).sync, false);
    assert.strictEqual(decide(v, CFG, { lastSyncAt: 0 }, SYNC_COOLDOWN_MS, true).sync, true);
  });

  it("explains itself in the reasons", () => {
    const d = decide(verdict({ interrupt: 0, graphOutdated: 0.8 }), CFG, {}, NOW, true);
    assert.deepStrictEqual(d.reasons, ["graph out of date (p=0.80)"]);
  });

  it("can happen together with an escalation, which is listed first", () => {
    const d = decide(verdict({ graphOutdated: 0.9 }), CFG, {}, NOW, true);
    assert.strictEqual(d.escalate, true);
    assert.strictEqual(d.sync, true);
    assert.strictEqual(d.reasons.length, 2);
    assert.match(d.reasons[0], /^possible logic error/);
    assert.strictEqual(d.reasons[1], "graph out of date (p=0.90)");
  });

  it("is independent of the sync cooldown for the other decisions", () => {
    const d = decide(verdict(), CFG, { lastSyncAt: NOW - 1_000 }, NOW, true);
    assert.strictEqual(d.escalate, true);
  });
});

describe("decide: explain", () => {
  const stuck = { interrupt: 0, struggling: 0.9 };

  it("needs struggling at the threshold (inclusive)", () => {
    assert.strictEqual(decide(verdict({ ...stuck, struggling: 0.75 }), CFG, {}, NOW, true).explain, true);
    assert.strictEqual(decide(verdict({ ...stuck, struggling: 0.74 }), CFG, {}, NOW, true).explain, false);
    assert.strictEqual(decide(verdict({ ...stuck, struggling: 0.8 }), { ...CFG, explainThreshold: 0.95 }, {}, NOW, true).explain, false);
  });

  it("has a five minute cooldown", () => {
    const v = verdict(stuck);
    assert.strictEqual(decide(v, CFG, { lastExplainAt: NOW - (EXPLAIN_COOLDOWN_MS - 1) }, NOW, true).explain, false);
    assert.strictEqual(decide(v, CFG, { lastExplainAt: NOW - EXPLAIN_COOLDOWN_MS }, NOW, true).explain, true);
    assert.strictEqual(decide(v, CFG, { lastExplainAt: NOW - 4 * 60_000 }, NOW, true).explain, false);
  });

  it("a last explanation at time 0 still counts", () => {
    const v = verdict(stuck);
    assert.strictEqual(decide(v, CFG, { lastExplainAt: 0 }, 100_000, true).explain, false);
    assert.strictEqual(decide(v, CFG, { lastExplainAt: 0 }, EXPLAIN_COOLDOWN_MS, true).explain, true);
  });

  it("does not need a graph", () => {
    assert.strictEqual(decide(verdict(stuck), CFG, {}, NOW, false).explain, true);
  });

  it("is suppressed while escalating", () => {
    const d = decide(verdict({ struggling: 0.99 }), CFG, {}, NOW, true);
    assert.strictEqual(d.escalate, true);
    assert.strictEqual(d.explain, false);
    assert.ok(!d.reasons.some((r) => r.includes("stuck")));
  });

  it("is allowed when the escalation was blocked by the cooldown", () => {
    const d = decide(verdict({ struggling: 0.99 }), CFG, { lastInterruptAt: NOW - 1_000 }, NOW, true);
    assert.strictEqual(d.escalate, false);
    assert.strictEqual(d.explain, true);
    assert.deepStrictEqual(d.reasons, ["interrupt cooldown", "programmer may be stuck (p=0.99)"]);
  });

  it("is allowed when the interrupt probability is too low", () => {
    const d = decide(verdict({ interrupt: 0.2, struggling: 0.8 }), CFG, {}, NOW, true);
    assert.deepStrictEqual(d, { escalate: false, sync: false, explain: true, reasons: ["programmer may be stuck (p=0.80)"] });
  });

  it("can happen together with a sync, which is listed first", () => {
    const d = decide(verdict({ interrupt: 0, graphOutdated: 0.8, struggling: 0.8 }), CFG, {}, NOW, true);
    assert.strictEqual(d.sync, true);
    assert.strictEqual(d.explain, true);
    assert.deepStrictEqual(d.reasons, ["graph out of date (p=0.80)", "programmer may be stuck (p=0.80)"]);
  });
});

describe("decide: nothing to do", () => {
  it("returns an empty decision for a calm verdict", () => {
    assert.deepStrictEqual(decide(verdict({ interrupt: 0.1, issue: "none", issueProbability: 0.05, severity: 0 }), CFG, {}, NOW, true), {
      escalate: false,
      sync: false,
      explain: false,
      reasons: [],
    });
  });

  it("does not mutate its inputs", () => {
    const v = verdict();
    const st: PolicyState = { lastInterruptAt: NOW - 1_000 };
    const vCopy = { ...v };
    const stCopy = { ...st };
    decide(v, CFG, st, NOW, true);
    assert.deepStrictEqual(v, vCopy);
    assert.deepStrictEqual(st, stCopy);
  });
});

// ---------------------------------------------------------------- beatDue

describe("beatDue", () => {
  const due: BeatTiming = { now: 100_000, lastBeatAt: 50_000, lastEditAt: 97_000, editsSinceBeat: 3, intervalMs: 45_000, focused: true };

  it("is due when focused, edited, the interval passed and the programmer paused", () => {
    assert.strictEqual(beatDue(due), true);
  });

  it("is never due when the editor is not focused", () => {
    assert.strictEqual(beatDue({ ...due, focused: false }), false);
  });

  it("is never due without edits since the last beat", () => {
    assert.strictEqual(beatDue({ ...due, editsSinceBeat: 0 }), false);
    assert.strictEqual(beatDue({ ...due, editsSinceBeat: 1 }), true);
  });

  it("waits for the full interval since the last beat", () => {
    assert.strictEqual(beatDue({ ...due, lastBeatAt: 100_000 - 44_999 }), false);
    assert.strictEqual(beatDue({ ...due, lastBeatAt: 100_000 - 45_000 }), true);
    assert.strictEqual(beatDue({ ...due, intervalMs: 60_000 }), false);
  });

  it("waits for a two second pause in typing", () => {
    assert.strictEqual(beatDue({ ...due, lastEditAt: 100_000 - 1_999 }), false);
    assert.strictEqual(beatDue({ ...due, lastEditAt: 100_000 - 2_000 }), true);
    assert.strictEqual(beatDue({ ...due, lastEditAt: 100_000 }), false, "typing right now");
  });

  it("the pause can be overridden", () => {
    assert.strictEqual(beatDue({ ...due, lastEditAt: 100_000 - 500 }, 500), true);
    assert.strictEqual(beatDue({ ...due, lastEditAt: 100_000 - 3_000 }, 5_000), false);
    assert.strictEqual(beatDue({ ...due, lastEditAt: 100_000 }, 0), true);
  });

  it("every condition is required", () => {
    const failing: Partial<BeatTiming>[] = [{ focused: false }, { editsSinceBeat: 0 }, { lastBeatAt: 99_000 }, { lastEditAt: 99_500 }];
    for (const f of failing) {
      assert.strictEqual(beatDue({ ...due, ...f }), false, JSON.stringify(f));
    }
  });
});

// ---------------------------------------------------------------- describeVerdict

describe("describeVerdict", () => {
  it("summarizes a jev verdict on one line", () => {
    assert.strictEqual(
      describeVerdict(verdict({ interrupt: 0.9, issue: "logic_error", severity: 2, graphOutdated: 0.1, struggling: 0.3 })),
      "jev: interrupt 0.90 · logic error · severity 2.0 · graph 0.10 · stuck 0.30",
    );
  });

  it("says 'no issue' for none", () => {
    assert.strictEqual(
      describeVerdict(verdict({ source: "llm", interrupt: 0.05, issue: "none", severity: 0, graphOutdated: 0, struggling: 0 })),
      "llm: interrupt 0.05 · no issue · severity 0.0 · graph 0.00 · stuck 0.00",
    );
  });

  it("replaces every underscore in the issue name", () => {
    assert.match(describeVerdict(verdict({ issue: "deviates_from_graph" })), /· deviates from graph ·/);
    assert.match(describeVerdict(verdict({ issue: "better_implementation" })), /· better implementation ·/);
  });

  it("rounds to two decimals for probabilities and one for severity", () => {
    const text = describeVerdict(verdict({ interrupt: 0.66666, severity: 2.26, graphOutdated: 0.004, struggling: 0.999 }));
    assert.ok(text.includes("interrupt 0.67"), text);
    assert.ok(text.includes("severity 2.3"), text);
    assert.ok(text.includes("graph 0.00"), text);
    assert.ok(text.includes("stuck 1.00"), text);
  });
});

// ---------------------------------------------------------------- reconcileInterrupts

function interrupt(id: string, line: number, lineText: string | undefined, over: Partial<Extract<FeedItem, { kind: "interrupt" }>> = {}): FeedItem {
  return {
    id,
    ts: "2026-01-01T00:00:00.000Z",
    kind: "interrupt",
    title: "Problem",
    message: "Something is off.",
    line,
    issue: "logic_error",
    severity: 2,
    status: "open",
    ...(lineText === undefined ? {} : { lineText }),
    ...over,
  } as FeedItem;
}

/** A file whose line `i` reads `line i` unless overridden. */
function fileLines(n: number, over: Record<number, string> = {}): string[] {
  return Array.from({ length: n }, (_, i) => over[i] ?? `line ${i}`);
}

describe("reconcileInterrupts", () => {
  it("reports nothing when the flagged line is unchanged", () => {
    const feed = [interrupt("a", 3, "line 3")];
    assert.deepStrictEqual(reconcileInterrupts(feed, fileLines(10)), []);
  });

  it("ignores indentation and trailing whitespace when comparing", () => {
    const feed = [interrupt("a", 1, "    return x  ")];
    assert.deepStrictEqual(reconcileInterrupts(feed, ["def f():", "\treturn x", ""]), []);
    const moved = reconcileInterrupts(feed, ["# new", "def f():", "return x"]);
    assert.deepStrictEqual(moved, [{ id: "a", line: 2, resolved: false }]);
  });

  it("follows the line down when lines are inserted above it", () => {
    const feed = [interrupt("a", 5, "line 5")];
    const lines = ["new 1", "new 2", "new 3", ...fileLines(10)];
    assert.deepStrictEqual(reconcileInterrupts(feed, lines), [{ id: "a", line: 8, resolved: false }]);
  });

  it("follows the line up when lines are deleted above it", () => {
    const feed = [interrupt("a", 5, "line 5")];
    const lines = fileLines(10).slice(2);
    assert.deepStrictEqual(reconcileInterrupts(feed, lines), [{ id: "a", line: 3, resolved: false }]);
  });

  it("can move to line 0", () => {
    const feed = [interrupt("a", 3, "line 3")];
    assert.deepStrictEqual(reconcileInterrupts(feed, fileLines(10).slice(3)), [{ id: "a", line: 0, resolved: false }]);
  });

  it("follows a move of up to 30 lines but no further", () => {
    const text = "the flagged line";
    const feed = [interrupt("a", 10, text)];
    const at = (n: number) => {
      const lines = Array.from({ length: 80 }, (_, i) => `filler ${i}`);
      lines[n] = text;
      return lines;
    };
    assert.deepStrictEqual(reconcileInterrupts(feed, at(40)), [{ id: "a", line: 40, resolved: false }]);
    assert.deepStrictEqual(reconcileInterrupts(feed, at(41)), [{ id: "a", resolved: true }]);
    assert.deepStrictEqual(reconcileInterrupts(feed, at(0)), [{ id: "a", line: 0, resolved: false }]);
    const feed2 = [interrupt("b", 40, text)];
    assert.deepStrictEqual(reconcileInterrupts(feed2, at(10)), [{ id: "b", line: 10, resolved: false }]);
    assert.deepStrictEqual(reconcileInterrupts(feed2, at(9)), [{ id: "b", resolved: true }]);
  });

  it("prefers the nearest copy of the line", () => {
    const text = "x = compute()";
    const feed = [interrupt("a", 10, text)];
    const lines = fileLines(30, { 15: text, 7: text });
    assert.deepStrictEqual(reconcileInterrupts(feed, lines), [{ id: "a", line: 7, resolved: false }]);
  });

  it("on a tie, prefers the copy below", () => {
    const text = "x = compute()";
    const feed = [interrupt("a", 10, text)];
    const lines = fileLines(30, { 12: text, 8: text });
    assert.deepStrictEqual(reconcileInterrupts(feed, lines), [{ id: "a", line: 12, resolved: false }]);
  });

  it("resolves the interrupt when its line was edited", () => {
    const feed = [interrupt("a", 3, "total = a + b")];
    const lines = fileLines(10, { 3: "total = a + b + c" });
    assert.deepStrictEqual(reconcileInterrupts(feed, lines), [{ id: "a", resolved: true }]);
  });

  it("resolves the interrupt when its line was removed", () => {
    const feed = [interrupt("a", 3, "line 3")];
    const lines = fileLines(10).filter((l) => l !== "line 3");
    assert.deepStrictEqual(reconcileInterrupts(feed, lines), [{ id: "a", resolved: true }]);
  });

  it("resolves the interrupt when the file became shorter than the flagged line", () => {
    const feed = [interrupt("a", 50, "line 50")];
    assert.deepStrictEqual(reconcileInterrupts(feed, fileLines(5)), [{ id: "a", resolved: true }]);
    assert.deepStrictEqual(reconcileInterrupts(feed, []), [{ id: "a", resolved: true }]);
  });

  it("a resolved entry has no line", () => {
    const [r] = reconcileInterrupts([interrupt("a", 0, "gone")], ["something else"]);
    assert.strictEqual("line" in r, false);
  });

  it("a flagged blank line that now has code is resolved, never 'moved' to another blank line", () => {
    const feed = [interrupt("a", 2, "   ")];
    const lines = ["a", "", "code now", "", "b"];
    assert.deepStrictEqual(reconcileInterrupts(feed, lines), [{ id: "a", resolved: true }]);
  });

  it("a flagged blank line that is still blank is unchanged", () => {
    const feed = [interrupt("a", 1, "")];
    assert.deepStrictEqual(reconcileInterrupts(feed, ["a", "   ", "b"]), []);
  });

  it("ignores interrupts that are not open", () => {
    const feed = [
      interrupt("r", 2, "gone", { status: "resolved" }),
      interrupt("d", 2, "gone", { status: "dismissed" }),
      interrupt("o", 2, "gone"),
    ];
    assert.deepStrictEqual(reconcileInterrupts(feed, fileLines(5)), [{ id: "o", resolved: true }]);
  });

  it("ignores feed items that are not interrupts", () => {
    const feed: FeedItem[] = [
      { id: "u", ts: "t", kind: "user", text: "hi" },
      { id: "a", ts: "t", kind: "assistant", text: "hello", mode: "chat" },
      { id: "s", ts: "t", kind: "system", text: "note", level: "info" },
      { id: "c", ts: "t", kind: "code_ref", path: "x.py", line: 3, note: "look" },
      { id: "q", ts: "t", kind: "question", question: "?", options: [] },
      { id: "res", ts: "t", kind: "resources", topic: "t", items: [] },
    ];
    assert.deepStrictEqual(reconcileInterrupts(feed, fileLines(5)), []);
  });

  it("ignores interrupts that never recorded the text of their line", () => {
    assert.deepStrictEqual(reconcileInterrupts([interrupt("a", 3, undefined)], fileLines(10, { 3: "changed" })), []);
  });

  it("handles several interrupts independently, in feed order", () => {
    const feed = [
      interrupt("shifted", 1, "line 1"),
      interrupt("moved", 4, "line 4"),
      interrupt("edited", 6, "line 6"),
      interrupt("done", 8, "line 8", { status: "resolved" }),
    ];
    const lines = ["inserted", ...fileLines(10, { 6: "line six, rewritten" })];
    // Everything moved down by one line, so "shifted" and "moved" follow their text.
    assert.deepStrictEqual(reconcileInterrupts(feed, lines), [
      { id: "shifted", line: 2, resolved: false },
      { id: "moved", line: 5, resolved: false },
      { id: "edited", resolved: true },
    ]);
  });

  it("does not modify the feed", () => {
    const feed = [interrupt("a", 3, "line 3")];
    const copy = JSON.parse(JSON.stringify(feed)) as FeedItem[];
    reconcileInterrupts(feed, fileLines(10, { 3: "changed" }));
    assert.deepStrictEqual(feed, copy);
  });

  it("returns an empty list for an empty feed", () => {
    assert.deepStrictEqual(reconcileInterrupts([], ["x"]), []);
  });
});
