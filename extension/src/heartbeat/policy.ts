// Heartbeat policy, pure: the questions put to Jev, how its calibrated answers
// become a verdict, when a verdict escalates to the LLM, and when a beat is due.

import type { HeartbeatConfig } from "../config/env";
import { choice, type JevQuestion, type JevResult, noul, score } from "../llm/jev";
import type { FeedItem, IssueKind } from "../types";

export type TriageIssue = IssueKind | "none";

export interface TriageVerdict {
  source: "jev" | "llm";
  /** P(worth interrupting now). */
  interrupt: number;
  issue: TriageIssue;
  /** P(there is some issue), i.e. 1 − P(none). */
  issueProbability: number;
  /** 0 cosmetic … 3 blocks progress. */
  severity: number;
  graphOutdated: number;
  struggling: number;
  latencyMs?: number;
}

export const ISSUE_CRITERIA: Record<TriageIssue, string> = {
  none: "No real problem: the code is fine, or simply unfinished and still being typed",
  typo: "A misspelled identifier, attribute, key or string that will make the code fail",
  syntax: "A syntax error: the code will not parse",
  logic_error: "Wrong logic: off-by-one, inverted condition, wrong variable, wrong order of operations",
  api_misuse: "A library or language API used incorrectly: wrong arguments, ignored return value or error, deprecated call",
  better_implementation: "It works, but a clearly simpler, faster or more idiomatic approach exists",
  missing_edge_case: "An input or failure case (empty, None/null, error response, timeout) is not handled",
  deviates_from_graph: "The code departs from the agreed implementation plan in a way that matters",
  security: "A security problem: injection, unsafe deserialization, secrets in code, missing validation",
  other: "Another concrete problem worth pointing out",
};

export const SEVERITY_LEVELS = [
  "Cosmetic; can be ignored",
  "Minor; mention at the next natural pause",
  "Should be fixed before moving on",
  "Will cause a bug or blocks progress; interrupt now",
];

/** The typed questions each heartbeat asks Jev (run in parallel by Jev). */
export const JEV_QUESTIONS: Record<string, JevQuestion> = {
  interrupt: {
    type: "noul",
    instructions:
      "Look at recent_change and current_scope_code. Is there a real problem in what the programmer just typed that is worth " +
      "interrupting them for right now? Code that is unfinished or still being typed is not a problem; neither are style preferences.",
    criteria: {
      true: "A concrete mistake, or a clearly better approach, that the programmer should hear about now",
      false: "The code is fine, still in progress, or the issue is too minor to interrupt for",
    },
  },
  issue: {
    type: "choice",
    instructions: "What is the most important problem in the programmer's latest change?",
    criteria: Object.fromEntries(Object.entries(ISSUE_CRITERIA).filter(([k]) => k !== "other")),
  },
  severity: {
    type: "score",
    instructions: "How severe is that problem for the program and for the programmer's progress?",
    criteria: SEVERITY_LEVELS,
  },
  graph_outdated: {
    type: "noul",
    instructions:
      "Compare plan (the implementation graph) with the code. Has the code moved away from the plan: symbols renamed, added, " +
      "or abandoned in the code but not in the plan, or signatures that differ?",
  },
  struggling: {
    type: "noul",
    instructions:
      "Does the programmer appear stuck on a concept: rewriting the same lines repeatedly, trial and error, contradictory attempts, " +
      "or asking about the same thing again?",
  },
};

export function verdictFromJev(r: JevResult): TriageVerdict {
  const issue = choice(r, "issue");
  const pNone = issue?.probabilities.none;
  const issueName = (issue?.choice ?? "none") as TriageIssue;
  const issueProbability =
    pNone !== undefined ? 1 - pNone : issueName !== "none" ? (issue?.confidence ?? 0.5) : 1 - (issue?.confidence ?? 1);
  return {
    source: "jev",
    interrupt: noul(r, "interrupt") ?? 0,
    issue: Object.hasOwn(ISSUE_CRITERIA, issueName) ? issueName : "other",
    issueProbability: clamp01(issueProbability),
    severity: score(r, "severity")?.score ?? 0,
    graphOutdated: noul(r, "graph_outdated") ?? 0,
    struggling: noul(r, "struggling") ?? 0,
    latencyMs: r.latencyMs,
  };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Parse the LLM fallback triage (JSON object, possibly wrapped in prose or a code fence). */
export function verdictFromLlmJson(text: string): TriageVerdict | undefined {
  const raw = firstJsonObject(text);
  if (!raw) {
    return undefined;
  }
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const issue = String(j.issue ?? "none") as TriageIssue;
    const known = Object.hasOwn(ISSUE_CRITERIA, issue) ? issue : "other";
    return {
      source: "llm",
      interrupt: clamp01(Number(j.interrupt)),
      issue: known,
      issueProbability: known === "none" ? 0 : 1,
      severity: Math.min(3, Math.max(0, Number(j.severity) || 0)),
      graphOutdated: clamp01(Number(j.graph_outdated)),
      struggling: clamp01(Number(j.struggling)),
    };
  } catch {
    return undefined;
  }
}

/** The first balanced `{…}` in `text` (string-aware), e.g. inside prose or a code fence. */
export function firstJsonObject(text: string): string | undefined {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
      } else if (c === "{") {
        depth++;
      } else if (c === "}" && --depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          break; // not JSON; try the next "{"
        }
      }
    }
  }
  return undefined;
}

export interface PolicyState {
  lastInterruptAt?: number;
  lastSyncAt?: number;
  lastExplainAt?: number;
}

export interface Decision {
  escalate: boolean;
  sync: boolean;
  explain: boolean;
  reasons: string[];
}

export const SYNC_COOLDOWN_MS = 3 * 60_000;
export const EXPLAIN_COOLDOWN_MS = 5 * 60_000;
export const MIN_SEVERITY = 1.5;
export const URGENT_SEVERITY = 2.5;

export function decide(v: TriageVerdict, cfg: HeartbeatConfig, st: PolicyState, now: number, hasGraph: boolean): Decision {
  const reasons: string[] = [];
  let escalate = v.interrupt >= cfg.interruptThreshold && v.issue !== "none" && v.issueProbability >= 0.5 && v.severity >= MIN_SEVERITY;
  if (escalate) {
    const cooling = st.lastInterruptAt !== undefined && now - st.lastInterruptAt < cfg.cooldownMs;
    if (cooling && v.severity < URGENT_SEVERITY) {
      escalate = false;
      reasons.push("interrupt cooldown");
    } else {
      reasons.push(`possible ${v.issue.replace(/_/g, " ")} (p=${v.interrupt.toFixed(2)}, severity ${v.severity.toFixed(1)})`);
    }
  }
  const sync =
    hasGraph &&
    v.graphOutdated >= cfg.graphSyncThreshold &&
    (st.lastSyncAt === undefined || now - st.lastSyncAt >= SYNC_COOLDOWN_MS);
  if (sync) {
    reasons.push(`graph out of date (p=${v.graphOutdated.toFixed(2)})`);
  }
  const explain =
    !escalate &&
    v.struggling >= cfg.explainThreshold &&
    (st.lastExplainAt === undefined || now - st.lastExplainAt >= EXPLAIN_COOLDOWN_MS);
  if (explain) {
    reasons.push(`programmer may be stuck (p=${v.struggling.toFixed(2)})`);
  }
  return { escalate, sync, explain, reasons };
}

export interface BeatTiming {
  now: number;
  lastBeatAt: number;
  lastEditAt: number;
  editsSinceBeat: number;
  intervalMs: number;
  focused: boolean;
}

/** A beat is due when there was typing since the last one, the interval has passed, and the programmer paused briefly. */
export function beatDue(t: BeatTiming, pauseMs = 2000): boolean {
  return t.focused && t.editsSinceBeat > 0 && t.now - t.lastBeatAt >= t.intervalMs && t.now - t.lastEditAt >= pauseMs;
}

export function describeVerdict(v: TriageVerdict): string {
  const issue = v.issue === "none" ? "no issue" : v.issue.replace(/_/g, " ");
  return `${v.source}: interrupt ${v.interrupt.toFixed(2)} · ${issue} · severity ${v.severity.toFixed(1)} · graph ${v.graphOutdated.toFixed(2)} · stuck ${v.struggling.toFixed(2)}`;
}

/**
 * Interrupts whose flagged line was edited are resolved; ones whose line only
 * moved (lines inserted above) follow it. Returns the items that changed.
 */
export function reconcileInterrupts(feed: FeedItem[], lines: string[]): { id: string; line?: number; resolved: boolean }[] {
  const out: { id: string; line?: number; resolved: boolean }[] = [];
  for (const item of feed) {
    if (item.kind !== "interrupt" || item.status !== "open" || item.lineText === undefined) {
      continue;
    }
    const want = item.lineText.trim();
    if (lines[item.line]?.trim() === want) {
      continue;
    }
    let moved: number | undefined;
    for (let d = 1; d <= 30 && moved === undefined; d++) {
      for (const cand of [item.line + d, item.line - d]) {
        if (cand >= 0 && cand < lines.length && lines[cand].trim() === want && want !== "") {
          moved = cand;
          break;
        }
      }
    }
    out.push(moved !== undefined ? { id: item.id, line: moved, resolved: false } : { id: item.id, resolved: true });
  }
  return out;
}
