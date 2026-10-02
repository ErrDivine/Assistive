// The heartbeat: while the programmer types, every few tens of seconds Jev
// triages the latest change (cheap, fast, calibrated); only when its answers
// cross the thresholds does the LLM take a closer look and possibly interrupt.

import type { EditTracker } from "../code/changes";
import { numberLines } from "../code/context";
import type { FileOutline } from "../code/outline";
import { symbolAt } from "../code/outline";
import type { AssistiveConfig } from "../config/env";
import { graphForJev } from "../graph/model";
import type { Llm } from "../llm/agent";
import type { JevClient } from "../llm/jev";
import { TRIAGE_JSON_SYSTEM } from "../llm/prompts";
import type { GraphStore } from "../store/GraphStore";
import type { Assistant, FileHandle, HeartbeatOutcome } from "../assistant/Assistant";
import {
  beatDue,
  decide,
  describeVerdict,
  JEV_QUESTIONS,
  type PolicyState,
  type TriageVerdict,
  verdictFromJev,
  verdictFromLlmJson,
} from "./policy";

export interface HeartbeatDeps {
  config(): AssistiveConfig;
  enabled(): boolean;
  jev(): JevClient | undefined;
  llm(): Llm | undefined;
  /** The file in the active editor, when it is a supported language. */
  active(): FileHandle | undefined;
  focused(): boolean;
  edits: EditTracker;
  store: GraphStore;
  assistant: Assistant;
  outlineOf(rel: string, text: string, language?: string): Promise<FileOutline>;
  onBeat(report: BeatReport): void;
  log(message: string): void;
  now?: () => number;
}

export interface BeatReport {
  file: string;
  at: number;
  verdict?: TriageVerdict;
  outcome: HeartbeatOutcome | "skipped" | "error";
  actions: string[];
  error?: string;
}

const TICK_MS = 3000;

export class Heartbeat {
  private timer?: NodeJS.Timeout;
  private beating = false;
  private readonly lastBeatAt = new Map<string, number>();
  private readonly policy = new Map<string, PolicyState>();
  private readonly now: () => number;

  constructor(private readonly deps: HeartbeatDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.stop();
  }

  private state(file: string): PolicyState {
    let st = this.policy.get(file);
    if (!st) {
      st = {};
      this.policy.set(file, st);
    }
    return st;
  }

  /** Record that an interrupt is on screen (resets the cooldown). */
  noteInterrupt(file: string): void {
    this.state(file).lastInterruptAt = this.now();
  }

  async tick(): Promise<void> {
    if (this.beating || !this.deps.enabled()) {
      return;
    }
    const h = this.deps.active();
    if (!h) {
      return;
    }
    const stats = this.deps.edits.stats(h.key);
    const due = beatDue({
      now: this.now(),
      lastBeatAt: this.lastBeatAt.get(h.key) ?? 0,
      lastEditAt: stats.lastEditAt,
      editsSinceBeat: stats.editsSinceBeat,
      intervalMs: this.deps.config().heartbeat.intervalMs,
      focused: this.deps.focused(),
    });
    if (due) {
      await this.beat(h);
    }
  }

  /** Run one heartbeat now (also the "Beat now" button). */
  async beat(h: FileHandle | undefined = this.deps.active()): Promise<BeatReport | undefined> {
    if (!h || this.beating) {
      return undefined;
    }
    this.beating = true;
    const at = this.now();
    this.lastBeatAt.set(h.key, at);
    const report: BeatReport = { file: h.key, at, outcome: "no_action", actions: [] };
    const text = h.text();
    try {
      const outline = await this.deps.assistant.localSync(h);
      const diff = this.deps.edits.diff(h.key, text, "last_heartbeat", 4000);
      const cfg = this.deps.config();
      const verdict = await this.triage(h, text, outline, diff, cfg);
      // The next diff starts from what was triaged (typing during escalation stays in it).
      this.deps.edits.beat(h.key, text);
      if (!verdict) {
        report.outcome = "skipped";
        return report;
      }
      report.verdict = verdict;
      const st = this.state(h.key);
      const graph = this.deps.store.graph(h.key);
      const d = decide(verdict, cfg.heartbeat, st, this.now(), !!graph?.nodes.length);
      report.actions = d.reasons;
      this.deps.log(`heartbeat ${h.file}: ${describeVerdict(verdict)}${d.reasons.length ? ` → ${d.reasons.join("; ")}` : ""}`);

      if (d.escalate && this.deps.llm()) {
        report.outcome = await this.deps.assistant.heartbeat(h, verdict, diff);
        if (report.outcome === "interrupted") {
          st.lastInterruptAt = this.now();
        }
      }
      if (d.sync && this.deps.llm()) {
        st.lastSyncAt = this.now();
        await this.deps.assistant.sync(h, "after a heartbeat").catch((e: Error) => this.deps.log(`sync failed: ${e.message}`));
      }
      if (d.explain && this.deps.llm()) {
        st.lastExplainAt = this.now();
        await this.deps.assistant.struggling(h, verdict, diff).catch((e: Error) => this.deps.log(`explain failed: ${e.message}`));
      }
      return report;
    } catch (err) {
      report.outcome = "error";
      report.error = (err as Error).message;
      this.deps.log(`heartbeat failed: ${report.error}`);
      return report;
    } finally {
      this.beating = false;
      this.deps.onBeat(report);
    }
  }

  private async triage(
    h: FileHandle,
    text: string,
    outline: FileOutline,
    diff: string,
    cfg: AssistiveConfig,
  ): Promise<TriageVerdict | undefined> {
    if (cfg.triage === "off") {
      return undefined;
    }
    const state = this.jevState(h, text, outline, diff);
    if (cfg.triage === "jev") {
      const jev = this.deps.jev();
      if (!jev) {
        throw new Error("Jev is not configured (set ASSISTIVE_JEV_API_KEY, or ASSISTIVE_TRIAGE=llm).");
      }
      return verdictFromJev(await jev.ask(state, JEV_QUESTIONS));
    }
    const llm = this.deps.llm();
    if (!llm) {
      return undefined;
    }
    const reply = await llm.text(
      [
        { role: "system", content: TRIAGE_JSON_SYSTEM },
        { role: "user", content: JSON.stringify(state) },
      ],
      undefined,
      true,
    );
    const v = verdictFromLlmJson(reply);
    if (!v) {
      throw new Error(`LLM triage was not JSON: ${reply.slice(0, 80)}`);
    }
    return v;
  }

  /** The application state Jev judges: small, structured, focused on the latest change. */
  jevState(h: FileHandle, text: string, outline: FileOutline, diff: string): Record<string, unknown> {
    const lines = text.split(/\r?\n/);
    const cursor = h.cursorLine();
    const at = Math.min(cursor ?? lines.length - 1, lines.length - 1);
    const sym = symbolAt(outline, at);
    let start = sym ? sym.line : Math.max(0, at - 15);
    let end = sym ? sym.endLine : Math.min(lines.length - 1, at + 15);
    if (end - start > 60) {
      start = Math.max(start, at - 30);
      end = Math.min(end, start + 60);
    }
    const graph = this.deps.store.graph(h.key);
    const feed = this.deps.store.get(h.key).feed;
    const conversation = feed
      .filter((f) => f.kind === "user" || f.kind === "assistant")
      .slice(-4)
      .map((f) => `${f.kind}: ${(f as { text: string }).text.slice(0, 300)}`);
    return {
      file: h.file,
      language: h.language,
      module_docstring: outline.moduleString?.text.slice(0, 1200) ?? "",
      plan: graph ? graphForJev(graph) : null,
      cursor: { line: at + 1, scope: sym?.signature ?? "module level" },
      current_scope_code: numberLines(text, start + 1, end + 1),
      recent_change: diff.slice(0, 3000) || "(no change)",
      diagnostics: h.ws
        .diagnostics(h.file)
        .slice(0, 10)
        .map((d) => `L${d.line + 1} ${d.severity}: ${d.message}`),
      recent_conversation: conversation,
      open_interrupts: feed
        .filter((f) => f.kind === "interrupt" && f.status === "open")
        .map((f) => (f as { title: string }).title),
    };
  }
}
