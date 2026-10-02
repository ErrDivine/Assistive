// Runs the LLM turns: drafting the graph from the module docstring, acting on
// the programmer's messages, syncing the graph with the code, and the
// heartbeat's escalations. Free of `vscode` so it can be tested with fakes.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { EditTracker } from "../code/changes";
import { type DiagnosticInfo, projectSummary, type WorkspaceAccess } from "../code/context";
import { type FileOutline, formatOutline, symbolAt } from "../code/outline";
import {
  clearAttention,
  compactGraph,
  describeSummary,
  emptyGraph,
  flagNodeAt,
  GraphEditor,
  syncWithOutline,
  unplannedSymbols,
} from "../graph/model";
import { describeVerdict, type TriageVerdict } from "../heartbeat/policy";
import type { AgentResult, AgentStep, Llm } from "../llm/agent";
import { contextBlock, instructionsFor, SYSTEM } from "../llm/prompts";
import { cursorDescription, toolsFor } from "../llm/tools";
import type { LinkCheck } from "../resources/links";
import type { GraphStore } from "../store/GraphStore";
import type { AgentMode, FeedItem, FileGraph, NewFeedItem, Resource } from "../types";

/** The file a turn is about. */
export interface FileHandle {
  /** Store key: the absolute path. */
  key: string;
  /** Path relative to `ws.root` (what the model sees). */
  file: string;
  ws: WorkspaceAccess;
  language: string;
  /** Live text (unsaved edits included). */
  text(): string;
  /** 0-based cursor line, when the file is in the active editor. */
  cursorLine(): number | undefined;
}

export interface AssistantDeps {
  llm(): Llm | undefined;
  store: GraphStore;
  edits: EditTracker;
  outlineOf(rel: string, text: string, language?: string): Promise<FileOutline>;
  checkLinks(items: Resource[]): Promise<LinkCheck>;
  /** Progress for the panel ("Drafting the graph…"); undefined when idle. */
  setBusy(file: string, label: string | undefined): void;
  log(message: string): void;
}

export type HeartbeatOutcome = "interrupted" | "stood_down" | "no_action";

const HISTORY_TURNS = 8;

function stepLabel(step: AgentStep): string | undefined {
  switch (step.tool) {
    case "read_file":
    case "get_file_outline":
      return `Reading ${(step.args as { path?: string })?.path ?? "the file"}…`;
    case "search_code":
      return `Searching for ${(step.args as { query?: string })?.query ?? "code"}…`;
    case "add_nodes":
    case "update_nodes":
    case "remove_nodes":
    case "connect":
    case "disconnect":
      return "Updating the graph…";
    case "recommend_resources":
      return "Checking links…";
    default:
      return undefined;
  }
}

export class Assistant {
  private readonly running = new Map<string, { mode: AgentMode | "struggling"; abort: AbortController }>();

  constructor(private readonly deps: AssistantDeps) {}

  isBusy(file: string): boolean {
    return this.running.has(file);
  }

  /** Cancel a running turn (e.g. a heartbeat when the programmer sends a message). */
  cancel(file: string, onlyMode?: AgentMode | "struggling"): void {
    const r = this.running.get(file);
    if (r && (!onlyMode || r.mode === onlyMode)) {
      r.abort.abort();
    }
  }

  /** Recompute node statuses from the code; cheap, runs on every beat and save. */
  async localSync(h: FileHandle): Promise<FileOutline> {
    const text = h.text();
    const outline = await this.deps.outlineOf(h.file, text, h.language);
    const graph = this.deps.store.graph(h.key);
    if (graph) {
      const copy = structuredClone(graph);
      if (syncWithOutline(copy, outline)) {
        this.deps.store.setGraph(h.key, copy, false);
      }
    }
    return outline;
  }

  // ------------------------------------------------------------ turns

  async draft(h: FileHandle): Promise<void> {
    const text = h.text();
    const outline = await this.deps.outlineOf(h.file, text, h.language);
    const doc = outline.moduleString?.text.trim();
    if (!doc) {
      this.note(h.key, "warn", this.docHint(h.language));
      return;
    }
    const existing = this.deps.store.graph(h.key);
    const project = await projectSummary(h.ws, h.file, outline, (rel, t) => this.deps.outlineOf(rel, t)).catch(
      (err: Error) => `(project context unavailable: ${err.message})`,
    );
    const redraft = existing && existing.nodes.length > 0;
    const content = contextBlock([
      ["File", `${h.file} (${h.language}, ${text.split("\n").length} lines)`],
      ["Module docstring", doc],
      ["Current outline", formatOutline(outline, { docstrings: true })],
      [
        "Existing graph",
        redraft
          ? `${compactGraph(existing!)}\n\nThe docstring changed since this graph was drafted. Revise the graph to match it: keep the ids of nodes that still fit, update or remove the others, add what is missing.`
          : undefined,
      ],
      ["Project context", project],
    ]);
    await this.turn(h, "draft", content, {
      busy: redraft ? "Redrafting the graph…" : "Drafting the graph…",
      base: existing ?? emptyGraph(h.file, h.language, doc),
      moduleString: doc,
      after: () => this.deps.edits.graphCreated(h.key, text),
    });
  }

  async chat(h: FileHandle, message: string): Promise<void> {
    this.cancel(h.key, "heartbeat");
    this.deps.store.addFeed(h.key, { kind: "user", text: message });
    const text = h.text();
    const outline = await this.deps.outlineOf(h.file, text, h.language);
    const graph = this.deps.store.graph(h.key);
    const line = h.cursorLine();
    const content = contextBlock([
      ["File", `${h.file} (${h.language}, ${text.split("\n").length} lines)`],
      ["Module docstring", outline.moduleString?.text],
      ["Cursor", cursorDescription(outline, line)],
      ["Outline", formatOutline(outline)],
      ["Graph", graph ? compactGraph(graph) : "(no graph yet: add nodes if the message asks for a plan)"],
      ["Diagnostics", formatDiagnostics(h.ws.diagnostics(h.file))],
      ["Message from the programmer", message],
    ]);
    await this.turn(h, "chat", content, {
      busy: "Thinking…",
      base: graph ?? emptyGraph(h.file, h.language, outline.moduleString?.text ?? ""),
      history: this.history(h.key, 1),
    });
  }

  async sync(h: FileHandle, why = "requested"): Promise<void> {
    const graph = this.deps.store.graph(h.key);
    if (!graph) {
      this.note(h.key, "info", "There is no graph to sync yet. Draft one first.");
      return;
    }
    const text = h.text();
    const outline = await this.deps.outlineOf(h.file, text, h.language);
    const copy = structuredClone(graph);
    syncWithOutline(copy, outline);
    const unplanned = unplannedSymbols(copy, outline).map((s) => `L${s.line + 1} ${s.signature}`);
    const content = contextBlock([
      ["File", `${h.file} (${h.language}); sync ${why}`],
      ["Outline", formatOutline(outline, { docstrings: true })],
      ["Graph", compactGraph(copy)],
      ["Symbols in the code that no node plans", unplanned.join("\n") || "(none)"],
      ["Edits since the graph was created", this.deps.edits.diff(h.key, text, "graph_created", 6000) || "(none)"],
    ]);
    await this.turn(h, "sync", content, { busy: "Syncing the graph with your code…", base: copy, quietIfUnchanged: why !== "requested" });
  }

  /** The heartbeat's escalation: the LLM decides whether to interrupt. */
  async heartbeat(h: FileHandle, verdict: TriageVerdict, recentDiff: string): Promise<HeartbeatOutcome> {
    if (this.isBusy(h.key)) {
      return "no_action";
    }
    const text = h.text();
    const lines = text.split(/\r?\n/);
    const outline = await this.deps.outlineOf(h.file, text, h.language);
    const graph = this.deps.store.graph(h.key);
    const line = h.cursorLine();
    const open = this.deps.store
      .get(h.key)
      .feed.filter((f): f is Extract<FeedItem, { kind: "interrupt" }> => f.kind === "interrupt" && f.status !== "resolved")
      .slice(-6)
      .map((f) => `- L${f.line + 1} ${f.issue}: ${f.title} (${f.status})`);
    const content = contextBlock([
      ["File", `${h.file} (${h.language}, ${lines.length} lines)`],
      ["Monitor verdict", describeVerdict(verdict)],
      ["Cursor", cursorDescription(outline, line)],
      ["Code around the cursor", scopeCode(outline, lines, line)],
      ["Recent edits (since the last heartbeat)", recentDiff || "(none)"],
      ["Diagnostics", formatDiagnostics(h.ws.diagnostics(h.file))],
      ["Graph", graph ? compactGraph(graph) : "(no graph)"],
      ["Already reported (do not repeat these)", open.join("\n")],
    ]);
    const res = await this.turn(h, "heartbeat", content, {
      busy: "Heartbeat: taking a closer look…",
      base: graph ?? emptyGraph(h.file, h.language, outline.moduleString?.text ?? ""),
      silent: true,
    });
    if (!res) {
      return "no_action";
    }
    if (res.steps.some((s) => s.tool === "interrupt_programmer" && s.ok)) {
      const item = this.deps.store
        .get(h.key)
        .feed.findLast((f): f is Extract<FeedItem, { kind: "interrupt" }> => f.kind === "interrupt" && f.status === "open");
      if (item) {
        await this.flag(h, item);
      }
      return "interrupted";
    }
    if (res.stopped || res.steps.some((s) => s.tool === "stand_down")) {
      return "stood_down";
    }
    return "no_action";
  }

  /** Mark the graph node that contains an interrupt's line. */
  async flag(h: FileHandle, item: Extract<FeedItem, { kind: "interrupt" }>): Promise<void> {
    const graph = this.deps.store.graph(h.key);
    if (!graph) {
      return;
    }
    const copy = structuredClone(graph);
    if (flagNodeAt(copy, await this.deps.outlineOf(h.file, h.text(), h.language), item.line, item.title)) {
      this.deps.store.setGraph(h.key, copy, false);
    }
  }

  /** Clear the node flag of an interrupt that was resolved or dismissed. */
  async unflag(h: FileHandle, item: Extract<FeedItem, { kind: "interrupt" }>): Promise<void> {
    const graph = this.deps.store.graph(h.key);
    if (!graph) {
      return;
    }
    const copy = structuredClone(graph);
    if (clearAttention(copy, await this.deps.outlineOf(h.file, h.text(), h.language), item.title)) {
      this.deps.store.setGraph(h.key, copy, false);
    }
  }

  /** The heartbeat thinks the programmer is stuck: offer resources. */
  async struggling(h: FileHandle, verdict: TriageVerdict, recentDiff: string): Promise<void> {
    if (this.isBusy(h.key)) {
      return;
    }
    const text = h.text();
    const outline = await this.deps.outlineOf(h.file, text, h.language);
    const content = contextBlock([
      ["File", `${h.file} (${h.language})`],
      ["Monitor verdict", describeVerdict(verdict)],
      ["Code around the cursor", scopeCode(outline, text.split(/\r?\n/), h.cursorLine())],
      ["Recent edits", recentDiff || "(none)"],
    ]);
    await this.turn(h, "heartbeat", content, {
      busy: "Looking for helpful resources…",
      base: this.deps.store.graph(h.key) ?? emptyGraph(h.file, h.language, ""),
      instructions: instructionsFor("struggling"),
      silent: true,
      mode: "struggling",
    });
  }

  /** "Explain" on an interrupt: a chat turn about it. */
  async explain(h: FileHandle, item: Extract<FeedItem, { kind: "interrupt" }>): Promise<void> {
    await this.chat(
      h,
      `Please explain "${item.title}" (line ${item.line + 1}) in more depth: why it is a problem, how to think about the fix, and a resource if one would help. Don't write the code for me.`,
    );
  }

  // ------------------------------------------------------------ machinery

  private async turn(
    h: FileHandle,
    mode: AgentMode,
    content: string,
    opts: {
      busy: string;
      base: FileGraph;
      moduleString?: string;
      history?: ChatCompletionMessageParam[];
      instructions?: string;
      /** Heartbeat turns post nothing unless a tool shows something. */
      silent?: boolean;
      quietIfUnchanged?: boolean;
      mode?: AgentMode | "struggling";
      after?: () => void;
    },
  ): Promise<AgentResult | undefined> {
    const llm = this.deps.llm();
    if (!llm) {
      if (!opts.silent) {
        this.note(h.key, "warn", "The LLM is not configured yet. Run **Assistive: Open API Configuration** and fill in the `.env` file.");
      }
      return undefined;
    }
    if (this.running.has(h.key)) {
      if (opts.silent) {
        return undefined;
      }
      this.cancel(h.key);
      await new Promise((r) => setTimeout(r, 50));
    }
    const abort = new AbortController();
    this.running.set(h.key, { mode: opts.mode ?? mode, abort });
    this.deps.setBusy(h.key, opts.busy);

    const store = this.deps.store;
    const before = store.graph(h.key);
    const editor = new GraphEditor(opts.base);
    if (opts.moduleString !== undefined) {
      editor.graph.moduleString = opts.moduleString;
    }
    let outline: FileOutline | undefined;
    let shown = 0;
    const outlineNow = async () => (outline ??= await this.deps.outlineOf(h.file, h.text(), h.language));
    const env = {
      ws: h.ws,
      file: h.file,
      language: h.language,
      liveText: () => h.text(),
      outlineOf: (rel: string, text: string) => this.deps.outlineOf(rel, text, rel === h.file ? h.language : undefined),
      editor,
      edits: this.deps.edits,
      checkLinks: (items: Resource[]) => this.deps.checkLinks(items),
      emit: (item: NewFeedItem) => {
        if (this.emit(h.key, item)) {
          shown++;
        }
      },
    };
    let finished = false;
    const publish = async () => {
      const g = editor.result();
      syncWithOutline(g, await outlineNow());
      if (!finished) {
        store.setGraph(h.key, g, false);
      }
    };

    try {
      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: `${SYSTEM}\n\n${opts.instructions ?? instructionsFor(mode)}` },
        ...(opts.history ?? []),
        { role: "user", content },
      ];
      const result = await llm.run({
        messages,
        tools: toolsFor(mode, env),
        signal: abort.signal,
        onStep: (step) => {
          const label = stepLabel(step);
          if (label) {
            this.deps.setBusy(h.key, label);
          }
          if (!step.ok) {
            this.deps.log(`${mode}: ${step.tool} → ${step.result.split("\n")[0]}`);
          }
          // Show graph edits live as they happen.
          if (editor.changed && /nodes|connect/.test(step.tool)) {
            void publish();
          }
        },
      });
      finished = true;
      const changes = editor.summary();
      if (editor.changed) {
        outline = undefined;
        const g = editor.result();
        syncWithOutline(g, await outlineNow());
        store.setGraph(h.key, g, before ?? false);
      }
      opts.after?.();
      const text = result.text.trim();
      let post: boolean;
      if (opts.silent) {
        // Heartbeat turns speak through their tools; the summary only accompanies visible output.
        post = editor.changed || (shown > 0 && !!text && !/^no help needed/i.test(text));
      } else if (mode === "sync") {
        post = editor.changed || !opts.quietIfUnchanged;
      } else {
        post = true;
      }
      if (post) {
        store.addFeed(h.key, {
          kind: "assistant",
          text: text || (editor.changed ? `Updated the graph (${describeSummary(changes)}).` : "Done."),
          changes: editor.changed ? changes : undefined,
          mode,
        });
      }
      this.deps.log(
        `${mode}: ${result.rounds} round(s), ${result.steps.length} tool call(s), ${result.usage.prompt}+${result.usage.completion} tokens` +
          (result.stopped ? `, stopped: ${result.stopped}` : ""),
      );
      return result;
    } catch (err) {
      finished = true;
      // Roll back live previews of a failed or cancelled turn.
      if (editor.changed) {
        store.setGraph(h.key, before, false);
      }
      if (abort.signal.aborted) {
        this.deps.log(`${mode}: cancelled`);
        return undefined;
      }
      const msg = (err as Error).message ?? String(err);
      this.deps.log(`${mode} failed: ${msg}`);
      if (!opts.silent) {
        this.note(h.key, "error", msg);
      }
      throw err;
    } finally {
      if (this.running.get(h.key)?.abort === abort) {
        this.running.delete(h.key);
      }
      this.deps.setBusy(h.key, undefined);
    }
  }

  private emit(file: string, item: NewFeedItem): boolean {
    if (item.kind === "interrupt") {
      // Never repeat an interrupt the programmer has already seen for the same line.
      const dup = this.deps.store
        .get(file)
        .feed.some(
          (f) =>
            f.kind === "interrupt" &&
            f.status !== "resolved" &&
            f.issue === item.issue &&
            (f.lineText ?? "").trim() === (item.lineText ?? "").trim(),
        );
      if (dup) {
        return false;
      }
    }
    this.deps.store.addFeed(file, item);
    return true;
  }

  /** Earlier user/assistant exchanges as chat messages (excluding the newest `skip` items). */
  private history(file: string, skip: number): ChatCompletionMessageParam[] {
    const feed = this.deps.store.get(file).feed;
    const items = feed
      .slice(0, Math.max(0, feed.length - skip))
      .filter((f) => f.kind === "user" || (f.kind === "assistant" && f.mode === "chat"))
      .slice(-HISTORY_TURNS);
    return items.map((f) =>
      f.kind === "user" ? { role: "user" as const, content: f.text } : { role: "assistant" as const, content: (f as { text: string }).text },
    );
  }

  private note(file: string, level: "info" | "warn" | "error", text: string): void {
    this.deps.store.addFeed(file, { kind: "system", level, text });
  }

  private docHint(language: string): string {
    return language === "python"
      ? 'Write a module docstring at the top of the file first (`"""What this module does…"""`); the graph is drafted from it.'
      : "Write a leading `/** … */` comment at the top of the file describing what it does; the graph is drafted from it.";
  }
}

export function formatDiagnostics(diags: DiagnosticInfo[]): string {
  return diags
    .slice(0, 15)
    .map((d) => `L${d.line + 1} ${d.severity}${d.source ? ` (${d.source})` : ""}: ${d.message}`)
    .join("\n");
}

/** The enclosing symbol's code (or ±15 lines) with 1-based numbers and a cursor marker. */
export function scopeCode(outline: FileOutline, lines: string[], cursor: number | undefined, maxLines = 70): string {
  if (!lines.length) {
    return "";
  }
  const at = Math.min(cursor ?? lines.length - 1, lines.length - 1);
  const sym = symbolAt(outline, at);
  let start = sym ? sym.line : Math.max(0, at - 15);
  let end = sym ? sym.endLine : Math.min(lines.length - 1, at + 15);
  if (end - start + 1 > maxLines) {
    start = Math.max(start, at - Math.floor(maxLines / 2));
    end = Math.min(end, start + maxLines - 1);
  }
  const width = String(end + 1).length;
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    out.push(`${i === at ? ">" : " "}${String(i + 1).padStart(width)}| ${lines[i]}`);
  }
  return out.join("\n");
}
