// Client for Jev, TypeSafe AI's System One model, in its official request format:
//   POST {base}/systemone  { model, state, questions: { name: { type, instructions, criteria? } } }
// Answers are calibrated probabilities:
//   noul   → { type: "noul", noul: p }
//   choice → { type: "choice", choice, probabilities: { option: p }, confidence }
//   score  → { type: "score", score, probabilities: { "0": p, ... }, confidence }
//            (score is the probability-weighted mean of the 0-based level numbers)

import type { JevConfig } from "../config/env";

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface NoulAnswer {
  type: "noul";
  /** Probability of "true". */
  noul: number;
}
export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface ScoreAnswer {
  type: "score";
  /** 0-based position along the levels (may fall between two). */
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}
export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevResult {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
  latencyMs: number;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JevError";
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function probs(v: unknown): Record<string, number> {
  if (Array.isArray(v)) {
    return Object.fromEntries(v.map((p, i) => [String(i), num(p)]));
  }
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, p]) => [k, num(p)]));
  }
  return {};
}

function argmax(p: Record<string, number>): string | undefined {
  let best: string | undefined;
  for (const [k, v] of Object.entries(p)) {
    if (best === undefined || v > p[best]) {
      best = k;
    }
  }
  return best;
}

/** Normalize one answer, tolerating small format variations. */
export function parseAnswer(question: JevQuestion, raw: unknown): JevAnswer | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const a = (typeof raw === "object" ? raw : { value: raw }) as Record<string, unknown>;
  switch (question.type) {
    case "noul": {
      const v = a.noul ?? a.probability ?? a.p ?? a.value;
      if (typeof v === "boolean") {
        return { type: "noul", noul: v ? 1 : 0 };
      }
      if (v === undefined) {
        return undefined;
      }
      return { type: "noul", noul: Math.min(1, Math.max(0, num(v))) };
    }
    case "choice": {
      const p = probs(a.probabilities);
      const choice = typeof a.choice === "string" ? a.choice : typeof a.answer === "string" ? a.answer : argmax(p);
      if (!choice) {
        return undefined;
      }
      return { type: "choice", choice, probabilities: p, confidence: num(a.confidence, p[choice] ?? 0) };
    }
    case "score": {
      const p = probs(a.probabilities);
      let score = a.score ?? a.value;
      if (score === undefined && Object.keys(p).length) {
        score = Object.entries(p).reduce((s, [k, v]) => s + Number(k) * v, 0);
      }
      if (score === undefined) {
        return undefined;
      }
      return { type: "score", score: num(score), probabilities: p, confidence: num(a.confidence) };
    }
  }
}

export class JevClient {
  constructor(
    private readonly cfg: JevConfig,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  get endpoint(): string {
    return `${this.cfg.baseUrl}/systemone`;
  }

  /** Ask typed questions about `state` (a string or JSON value). Questions run in parallel on Jev. */
  async ask(state: unknown, questions: Record<string, JevQuestion>, signal?: AbortSignal): Promise<JevResult> {
    const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ model: this.cfg.model, state, questions }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (timeout.aborted) {
        throw new JevError(`Jev did not answer within ${this.cfg.timeoutMs / 1000}s.`);
      }
      throw new JevError(`Could not reach Jev at ${this.endpoint}: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new JevError(describeHttpError(res.status, res.headers.get("content-type") ?? "", text), res.status);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new JevError(`Jev returned a response that is not JSON: ${text.slice(0, 120)}`);
    }
    const rawAnswers = (body.answers ?? body.results ?? {}) as Record<string, unknown>;
    const answers: Record<string, JevAnswer> = {};
    for (const [name, q] of Object.entries(questions)) {
      const a = parseAnswer(q, rawAnswers[name]);
      if (a) {
        answers[name] = a;
      }
    }
    if (!Object.keys(answers).length) {
      throw new JevError("Jev's response had no answers for the questions asked.");
    }
    return {
      model: typeof body.model === "string" ? body.model : this.cfg.model,
      answers,
      usage: body.usage as JevResult["usage"],
      latencyMs: Date.now() - started,
    };
  }
}

function describeHttpError(status: number, contentType: string, text: string): string {
  let detail = text.slice(0, 200);
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    detail = (typeof j.error === "string" ? j.error : j.error?.message) ?? j.message ?? detail;
  } catch {
    // keep the raw text
  }
  if (status === 401 || status === 403) {
    if (/html/i.test(contentType)) {
      return `Jev's edge firewall rejected the request (HTTP ${status}); code that looks like shell commands can trigger this.`;
    }
    return `Jev rejected the API key (HTTP ${status}). Check ASSISTIVE_JEV_API_KEY.`;
  }
  if (status === 429) {
    return "Jev rate limit reached (HTTP 429); the heartbeat will retry later.";
  }
  return `Jev error HTTP ${status}: ${detail}`;
}

/** Helpers for reading answers with defaults. */
export function noul(r: JevResult | undefined, name: string): number | undefined {
  const a = r?.answers[name];
  return a?.type === "noul" ? a.noul : undefined;
}
export function choice(r: JevResult | undefined, name: string): ChoiceAnswer | undefined {
  const a = r?.answers[name];
  return a?.type === "choice" ? a : undefined;
}
export function score(r: JevResult | undefined, name: string): ScoreAnswer | undefined {
  const a = r?.answers[name];
  return a?.type === "score" ? a : undefined;
}
