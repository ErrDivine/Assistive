// Wires the pieces to VS Code: the active file, its outline and edits, the
// .env configuration and API clients, the assistant and heartbeat, the panel,
// interrupt squiggles, the status bar item and the commands.
//
// Invariant I1: nothing here edits the programmer's buffers. The programmer
// types all code; "Copy signature" only uses the clipboard.

import * as path from "node:path";
import * as vscode from "vscode";
import { Assistant, type FileHandle } from "./assistant/Assistant";
import { EditTracker } from "./code/changes";
import { type FileOutline, outline as computeOutline } from "./code/outline";
import { TreeSitter } from "./code/treesitter";
import { VsWorkspace } from "./code/workspace";
import { type AssistiveConfig, ensureEnvFile, envCandidates, loadConfig } from "./config/env";
import { Debouncer } from "./code/debounce";
import { nodeForWord, orderedNodes, progress, toMermaid } from "./graph/model";
import { Heartbeat, type BeatReport } from "./heartbeat/Heartbeat";
import { describeVerdict, reconcileInterrupts } from "./heartbeat/policy";
import { Llm } from "./llm/agent";
import { JevClient } from "./llm/jev";
import { PanelProvider } from "./panel/PanelProvider";
import { checkLinks } from "./resources/links";
import { GraphStore } from "./store/GraphStore";
import type { FeedItem, FromPanel, PanelState, ServiceStatus } from "./types";

type Interrupt = Extract<FeedItem, { kind: "interrupt" }>;

const AUTO_DRAFT_DELAY_MS = 2500;
/** Statuses follow the code this long after the last keystroke. */
const LIVE_SYNC_DELAY_MS = 800;
const MIN_DOCSTRING_CHARS = 15;

export class Controller implements vscode.Disposable {
  readonly store: GraphStore;
  readonly edits = new EditTracker();
  readonly assistant: Assistant;
  readonly heartbeat: Heartbeat;
  readonly panel: PanelProvider;
  readonly log: vscode.LogOutputChannel;
  private readonly ts: TreeSitter;
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly statusItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly workspaces = new Map<string, VsWorkspace>();
  private readonly outlines = new Map<string, { text: string; outline: FileOutline }>();
  private readonly busy = new Map<string, string>();
  private readonly drafted = new Set<string>();
  /** First line edited per file since the last auto-draft check. */
  private readonly headEdits = new Map<string, number>();
  private readonly toasted = new Set<string>();
  private readonly errors: { llm?: string; jev?: string } = {};
  private config!: AssistiveConfig;
  private llmClient?: Llm;
  private jevClient?: JevClient;
  private activeDoc?: vscode.TextDocument;
  private lastBeat?: BeatReport;
  private panelState?: PanelState;
  private readonly refresh: Trigger;
  private readonly autoDraft: Trigger;
  private readonly reconcile: Trigger;
  private readonly liveSync: Trigger;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.log = vscode.window.createOutputChannel("Assistive", { log: true });
    const storage = ctx.storageUri ?? ctx.globalStorageUri;
    this.store = new GraphStore(storage.fsPath);
    this.ts = new TreeSitter(path.join(ctx.extensionPath, "dist", "wasm"));
    this.diagnostics = vscode.languages.createDiagnosticCollection("Assistive");
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.statusItem.command = "assistive.focus";
    this.statusItem.name = "Assistive";
    this.refresh = debounced(() => void this.pushState(), 60);
    this.autoDraft = debounced(() => void this.maybeAutoDraft(), AUTO_DRAFT_DELAY_MS);
    this.reconcile = debounced(() => this.reconcileInterrupts(), 400);
    this.liveSync = debounced(() => {
      const h = this.handle();
      if (h && this.store.graph(h.key)?.nodes.length) void this.assistant.localSync(h);
    }, LIVE_SYNC_DELAY_MS);

    this.reloadConfig();

    this.assistant = new Assistant({
      llm: () => this.llmClient,
      store: this.store,
      edits: this.edits,
      outlineOf: (rel, text, language) => this.outlineOf(rel, text, language),
      checkLinks: (items) => checkLinks(items, { verify: this.config.verifyLinks }),
      setStreaming: (key, text) => this.streamToPanel(key, text),
      setBusy: (key, label) => {
        if (label) this.busy.set(key, label);
        else this.busy.delete(key);
        this.refresh.trigger();
        this.updateStatusItem();
      },
      log: (m) => this.log.info(m),
    });

    this.heartbeat = new Heartbeat({
      config: () => this.config,
      enabled: () => this.heartbeatEnabled(),
      jev: () => this.jevClient,
      llm: () => this.llmClient,
      active: () => this.handle(),
      focused: () => vscode.window.state.focused,
      edits: this.edits,
      store: this.store,
      assistant: this.assistant,
      outlineOf: (rel, text, language) => this.outlineOf(rel, text, language),
      onBeat: (r) => this.onBeat(r),
      log: (m) => this.log.info(m),
    });

    this.panel = new PanelProvider(ctx.extensionUri, (m) => void this.onPanelMessage(m));

    this.disposables.push(
      this.log,
      this.diagnostics,
      this.statusItem,
      this.panel,
      vscode.window.registerWebviewViewProvider(PanelProvider.viewId, this.panel, { webviewOptions: { retainContextWhenHidden: true } }),
      this.store.onChange((key) => this.onStoreChange(key)),
      vscode.window.onDidChangeActiveTextEditor((e) => this.onActiveEditor(e)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocChange(e)),
      vscode.workspace.onDidSaveTextDocument((d) => this.onSave(d)),
      vscode.workspace.onDidOpenTextDocument((d) => this.track(d)),
      vscode.languages.registerHoverProvider(
        [{ scheme: "file" }, { scheme: "untitled" }],
        { provideHover: (doc, pos) => this.hover(doc, pos) },
      ),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("assistive")) {
          this.reloadConfig();
          this.refresh.trigger();
        }
      }),
      this.panel.onDidChangeVisibility(() => this.refresh.trigger()),
      { dispose: () => this.heartbeat.dispose() },
      { dispose: () => this.store.flush() },
      { dispose: () => this.refresh.cancel() },
      { dispose: () => this.autoDraft.cancel() },
      { dispose: () => this.reconcile.cancel() },
      { dispose: () => this.liveSync.cancel() },
      { dispose: () => clearTimeout(this.streamTimer) },
    );
    this.watchEnv();
    for (const d of vscode.workspace.textDocuments) this.track(d);
    this.onActiveEditor(vscode.window.activeTextEditor);
    this.heartbeat.start();
    this.updateStatusItem();
    this.statusItem.show();
  }

  // ------------------------------------------------------------ configuration

  private settings() {
    return vscode.workspace.getConfiguration("assistive");
  }

  heartbeatEnabled(): boolean {
    return this.settings().get<boolean>("heartbeat.enabled", true);
  }

  private envCandidates(): string[] {
    return envCandidates(this.settings().get<string>("envFile"), this.ctx.extensionPath);
  }

  reloadConfig(): void {
    const before = this.config?.source;
    this.config = loadConfig(this.envCandidates());
    this.llmClient = this.config.llmReady ? new Llm(this.config.llm) : undefined;
    this.jevClient = this.config.jevReady ? new JevClient(this.config.jev) : undefined;
    this.errors.llm = undefined;
    this.errors.jev = undefined;
    this.log.info(
      `config ${this.config.source ?? "(no .env found)"}: llm ${this.config.llmReady ? `${this.config.llm.model} @ ${this.config.llm.baseUrl}` : "missing"}, ` +
        `jev ${this.config.jevReady ? this.config.jev.model : "missing"}, triage ${this.config.triage}, heartbeat ${this.config.heartbeat.intervalMs / 1000}s`,
    );
    for (const p of this.config.problems) this.log.warn(p);
    if (before !== undefined && before !== this.config.source) {
      this.watchEnv();
    }
    this.refresh?.trigger();
  }

  private envWatcher?: vscode.Disposable;

  private watchEnv(): void {
    this.envWatcher?.dispose();
    const watchers: vscode.Disposable[] = [];
    for (const file of this.envCandidates()) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
      const reload = () => this.reloadConfig();
      watchers.push(w, w.onDidChange(reload), w.onDidCreate(reload), w.onDidDelete(reload));
    }
    this.envWatcher = vscode.Disposable.from(...watchers);
    this.disposables.push(this.envWatcher);
  }

  async openConfig(): Promise<void> {
    const target = this.config.source ?? this.envCandidates()[0];
    ensureEnvFile(target);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(doc, { preview: false });
    if (!this.config.source) {
      this.reloadConfig();
    }
  }

  // ------------------------------------------------------------ files

  private supported(doc: vscode.TextDocument | undefined): boolean {
    if (!doc || (doc.uri.scheme !== "file" && doc.uri.scheme !== "untitled")) {
      return false;
    }
    const langs = this.settings().get<string[]>("languages", ["python", "typescript", "typescriptreact", "javascript", "javascriptreact"]);
    return langs.includes(doc.languageId);
  }

  private wsFor(uri: vscode.Uri): VsWorkspace {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const root = folder?.uri.fsPath ?? path.dirname(uri.fsPath);
    let ws = this.workspaces.get(root);
    if (!ws) {
      ws = new VsWorkspace(root);
      this.workspaces.set(root, ws);
    }
    return ws;
  }

  handleFor(doc: vscode.TextDocument): FileHandle {
    const ws = this.wsFor(doc.uri);
    const file = path.relative(ws.root, doc.uri.fsPath).split(path.sep).join("/") || path.basename(doc.uri.fsPath);
    return {
      key: doc.uri.fsPath,
      file,
      ws,
      language: doc.languageId,
      text: () => doc.getText(),
      cursorLine: () => vscode.window.visibleTextEditors.find((e) => e.document === doc)?.selection.active.line,
    };
  }

  /** The file the panel shows: the active editor, or the last supported one. */
  handle(): FileHandle | undefined {
    const doc = this.activeDoc;
    return doc && !doc.isClosed && this.supported(doc) ? this.handleFor(doc) : undefined;
  }

  async outlineOf(rel: string, text: string, language?: string): Promise<FileOutline> {
    const lang = language ?? this.wsLanguage(rel) ?? "plaintext";
    const key = `${lang}:${rel}`;
    const hit = this.outlines.get(key);
    if (hit && hit.text === text) {
      return hit.outline;
    }
    const o = await computeOutline(this.ts, lang, text);
    this.outlines.set(key, { text, outline: o });
    if (this.outlines.size > 60) {
      this.outlines.delete(this.outlines.keys().next().value!);
    }
    return o;
  }

  private wsLanguage(rel: string): string | undefined {
    const first = this.workspaces.values().next().value;
    return first?.languageOf(rel) ?? new VsWorkspace("/").languageOf(rel);
  }

  private track(doc: vscode.TextDocument): void {
    if (this.supported(doc)) {
      this.edits.open(doc.uri.fsPath, doc.getText());
    }
  }

  private onActiveEditor(editor: vscode.TextEditor | undefined): void {
    if (!editor) {
      return; // focus moved to the panel or another view: keep showing the last file
    }
    const doc = editor.document;
    if (!this.supported(doc) && this.activeDoc && !this.activeDoc.isClosed) {
      return; // reading docs or config: keep showing the file being implemented
    }
    this.activeDoc = doc;
    this.track(doc);
    this.refresh.trigger();
  }

  private onDocChange(e: vscode.TextDocumentChangeEvent): void {
    if (!e.contentChanges.length || !this.supported(e.document)) {
      return;
    }
    const key = e.document.uri.fsPath;
    const lines: number[] = [];
    for (const c of e.contentChanges) {
      const added = c.text.split("\n").length - 1;
      for (let l = c.range.start.line; l <= c.range.start.line + added && lines.length < 50; l++) lines.push(l);
    }
    this.edits.edited(key, lines);
    if (e.document === this.activeDoc) {
      this.refresh.trigger();
      // Only typing near the head of the file (the docstring) can start a draft.
      this.headEdits.set(key, Math.min(this.headEdits.get(key) ?? Infinity, ...lines));
      this.autoDraft.trigger();
      this.liveSync.trigger();
    }
    this.reconcile.trigger();
  }

  private onSave(doc: vscode.TextDocument): void {
    if (this.config.source && doc.uri.fsPath === this.config.source) {
      this.reloadConfig();
      return;
    }
    if (this.supported(doc) && this.store.graph(doc.uri.fsPath)) {
      void this.assistant.localSync(this.handleFor(doc));
    }
  }

  private async maybeAutoDraft(): Promise<void> {
    const h = this.handle();
    if (!h || !this.settings().get<boolean>("autoDraft", true) || !this.llmClient || this.assistant.isBusy(h.key)) {
      return;
    }
    if (this.store.graph(h.key)?.nodes.length) {
      return;
    }
    const firstEdited = this.headEdits.get(h.key);
    this.headEdits.delete(h.key);
    const o = await this.outlineOf(h.file, h.text(), h.language);
    const doc = o.moduleString;
    if (!doc?.closed || doc.text.length < MIN_DOCSTRING_CHARS || firstEdited === undefined || firstEdited > doc.endLine + 1) {
      return;
    }
    const attempt = `${h.key}\n${doc.text}`;
    if (this.drafted.has(attempt)) {
      return; // already tried this docstring (e.g. the draft failed); the Draft button retries
    }
    this.drafted.add(attempt);
    await this.run(() => this.assistant.draft(h));
  }

  // ------------------------------------------------------------ interrupts

  private openInterrupts(key: string): Interrupt[] {
    return this.store.get(key).feed.filter((f): f is Interrupt => f.kind === "interrupt" && f.status === "open");
  }

  private reconcileInterrupts(): void {
    for (const doc of vscode.workspace.textDocuments) {
      const key = doc.uri.fsPath;
      if (!this.supported(doc) || !this.openInterrupts(key).length) {
        continue;
      }
      const changes = reconcileInterrupts(this.store.get(key).feed, doc.getText().split(/\r?\n/));
      for (const c of changes) {
        if (c.resolved) {
          this.closeInterrupt(key, c.id, "resolved");
        } else {
          this.store.updateFeed(key, c.id, { line: c.line });
        }
      }
    }
  }

  /** Resolve or dismiss an interrupt and clear the graph flag it set. */
  closeInterrupt(key: string, id: string, status: "resolved" | "dismissed"): void {
    const item = this.store.get(key).feed.find((f): f is Interrupt => f.id === id && f.kind === "interrupt");
    if (!item || item.status !== "open") {
      return;
    }
    this.store.updateFeed(key, id, { status });
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === key);
    if (doc) {
      void this.assistant.unflag(this.handleFor(doc), item);
    }
  }

  private renderDiagnostics(key: string): void {
    const uri = vscode.Uri.file(key);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === key);
    const diags = this.openInterrupts(key).map((f) => {
      const endLine = f.endLine ?? f.line;
      const lastText = doc && endLine < doc.lineCount ? doc.lineAt(endLine).text : "";
      const firstText = doc && f.line < doc.lineCount ? doc.lineAt(f.line).text : "";
      const startCol = firstText.length - firstText.trimStart().length;
      const range = new vscode.Range(f.line, startCol, endLine, Math.max(lastText.length, startCol + 1));
      const sev = f.severity >= 3 ? vscode.DiagnosticSeverity.Error : f.severity === 2 ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
      const d = new vscode.Diagnostic(range, `${f.title}: ${plain(f.message)}`, sev);
      d.source = "Assistive";
      d.code = f.issue;
      return d;
    });
    this.diagnostics.set(uri, diags);
  }

  private maybeToast(key: string): void {
    for (const f of this.openInterrupts(key)) {
      if (this.toasted.has(f.id)) {
        continue;
      }
      this.toasted.add(f.id);
      if (Date.now() - Date.parse(f.ts) > 120_000) {
        continue; // restored from an earlier session
      }
      this.heartbeat.noteInterrupt(key);
      if (this.panel.visible || this.settings().get<string>("notifications", "toast") !== "toast") {
        continue;
      }
      const show = f.severity >= 3 ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      void show(`Assistive: ${f.title} (line ${f.line + 1})`, "Show", "Explain", "Got it").then((choice) => {
        if (choice === "Show") void this.panelMessage({ type: "goto", line: f.line, endLine: f.endLine }, key);
        else if (choice === "Explain") void this.panelMessage({ type: "explain", id: f.id }, key);
        else if (choice === "Got it") this.closeInterrupt(key, f.id, "dismissed");
      });
    }
  }

  // ------------------------------------------------------------ state

  private onStoreChange(key: string): void {
    this.renderDiagnostics(key);
    this.maybeToast(key);
    this.updateStatusItem();
    if (key === this.activeDoc?.uri.fsPath) {
      this.refresh.trigger();
    }
  }

  private onBeat(r: BeatReport): void {
    if (r.outcome === "skipped" && !r.verdict) {
      return; // nothing was triaged: keep showing the last verdict
    }
    this.lastBeat = r;
    if (r.error) {
      if (/jev/i.test(r.error)) this.errors.jev = r.error;
      else this.errors.llm = r.error;
    } else if (r.verdict) {
      if (r.verdict.source === "jev") this.errors.jev = undefined;
      if (r.verdict.source === "llm" || r.outcome !== "no_action") this.errors.llm = undefined;
    }
    this.refresh.trigger();
  }

  private status(): ServiceStatus {
    const key = this.activeDoc?.uri.fsPath;
    const c = this.config;
    return {
      llm: !c.llmReady ? "missing" : this.errors.llm ? "error" : "ready",
      jev: c.triage !== "jev" ? "off" : !c.jevReady ? "missing" : this.errors.jev ? "error" : "ready",
      triage: c.triage,
      heartbeat: this.heartbeatEnabled() && c.triage !== "off" ? "on" : "paused",
      heartbeatSeconds: Math.round(c.heartbeat.intervalMs / 1000),
      lastBeat: this.lastBeat ? new Date(this.lastBeat.at).toISOString() : undefined,
      lastVerdict: this.lastBeat?.error ?? (this.lastBeat?.verdict ? describeVerdict(this.lastBeat.verdict) : undefined),
      busy: key ? this.busy.get(key) : undefined,
      configPath: c.source,
    };
  }

  async buildState(): Promise<PanelState> {
    const h = this.handle();
    const doc = this.activeDoc;
    if (!h) {
      return {
        file: doc && !doc.isClosed ? vscode.workspace.asRelativePath(doc.uri) : undefined,
        language: doc?.languageId,
        feed: [],
        status: this.status(),
        canUndo: false,
        supported: false,
      };
    }
    const o = await this.outlineOf(h.file, h.text(), h.language);
    const rec = this.store.get(h.key);
    return {
      file: h.file,
      language: h.language,
      moduleString: o.moduleString?.text,
      moduleStringClosed: o.moduleString?.closed,
      graph: rec.graph,
      feed: rec.feed,
      status: this.status(),
      canUndo: this.store.canUndo(h.key),
      supported: true,
    };
  }

  private async pushState(): Promise<void> {
    try {
      this.panelState = await this.buildState();
      this.panel.setState(this.panelState);
    } catch (err) {
      this.log.error(`panel state: ${(err as Error).message}`);
    }
  }

  /** The state last sent to the panel (for tests). */
  get lastPanelState(): PanelState | undefined {
    return this.panelState;
  }

  private updateStatusItem(): void {
    const key = this.activeDoc?.uri.fsPath;
    const open = key ? this.openInterrupts(key).length : 0;
    const busy = key ? this.busy.get(key) : undefined;
    const graph = key ? this.store.graph(key) : undefined;
    const p = graph?.nodes.length ? progress(graph) : undefined;
    const count = p?.total ? ` ${p.done}/${p.total}` : "";
    this.statusItem.text = busy
      ? `$(sync~spin) ${busy.replace(/…$/, "")}`
      : open
        ? `$(type-hierarchy)${count} $(warning) ${open}`
        : `$(type-hierarchy)${count}`;
    const plan = p?.total
      ? `Assistive: ${p.done} of ${p.total} pieces done${p.next ? ` · next: ${p.next.symbol ?? p.next.label}` : " · all done"}`
      : "Assistive: implementation graph";
    this.statusItem.tooltip = busy ?? (open ? `${open} open note${open > 1 ? "s" : ""} from the assistant\n${plan}` : plan);
    this.statusItem.backgroundColor = open && !busy ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  }

  // ------------------------------------------------------------ streaming

  private streamText?: { key: string; text?: string };
  private streamTimer?: NodeJS.Timeout;

  /** Send the reply as it streams, at most every 80 ms; the end of the stream goes at once. */
  private streamToPanel(key: string, text: string | undefined): void {
    this.streamText = { key, text };
    const flush = () => {
      this.streamTimer = undefined;
      const s = this.streamText;
      if (s && s.key === this.activeDoc?.uri.fsPath) this.panel.post({ type: "stream", text: s.text || undefined });
    };
    if (text === undefined) {
      clearTimeout(this.streamTimer);
      flush();
    } else {
      this.streamTimer ??= setTimeout(flush, 80);
    }
  }

  // ------------------------------------------------------------ hover

  /** The plan for the symbol under the mouse: read-only help while typing. */
  async hover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    if (!this.supported(doc)) return undefined;
    const graph = this.store.graph(doc.uri.fsPath);
    const range = doc.getWordRangeAtPosition(pos, /[A-Za-z_$][\w$]*/);
    if (!graph?.nodes.length || !range) return undefined;
    const h = this.handleFor(doc);
    const o = await this.outlineOf(h.file, doc.getText(), doc.languageId);
    const node = nodeForWord(graph, o, doc.getText(range), pos.line);
    if (!node) return undefined;
    const step = orderedNodes(graph).findIndex((n) => n.id === node.id) + 1;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Assistive plan** · ${node.status === "done" ? "✓ done" : node.status} · step ${step} of ${graph.nodes.length}\n\n`);
    if (node.signature) md.appendCodeblock(node.signature, doc.languageId);
    md.appendMarkdown(escapeMarkdown(node.description));
    if (node.notes.length) md.appendMarkdown("\n\n" + node.notes.map((n) => `- ${escapeMarkdown(n)}`).join("\n"));
    if (node.attention) md.appendMarkdown(`\n\n⚠ ${escapeMarkdown(node.attention)}`);
    return new vscode.Hover(md, range);
  }

  // ------------------------------------------------------------ actions

  /** Run an assistant action, reporting failures in the feed (already done by the Assistant) and the log. */
  private async run(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
      this.errors.llm = undefined;
    } catch (err) {
      this.errors.llm = (err as Error).message;
      this.log.error(this.errors.llm);
    }
    this.refresh.trigger();
  }

  private requireFile(): FileHandle | undefined {
    const h = this.handle();
    if (!h) {
      void vscode.window.showInformationMessage("Assistive: open a Python, TypeScript or JavaScript file first.");
    }
    return h;
  }

  async draft(): Promise<void> {
    const h = this.requireFile();
    if (h) await this.run(() => this.assistant.draft(h));
  }

  async sync(): Promise<void> {
    const h = this.requireFile();
    if (h) await this.run(() => this.assistant.sync(h));
  }

  async send(text: string): Promise<void> {
    const h = this.requireFile();
    if (h && text.trim()) await this.run(() => this.assistant.chat(h, text.trim()));
  }

  undo(): void {
    const h = this.requireFile();
    if (h && !this.store.undo(h.key)) {
      void vscode.window.showInformationMessage("Assistive: nothing to undo.");
    }
  }

  async clear(): Promise<void> {
    const h = this.requireFile();
    if (!h || !this.store.graph(h.key)) return;
    const ok = await vscode.window.showWarningMessage(`Clear the graph for ${h.file}? (Undo restores it.)`, { modal: true }, "Clear");
    if (ok === "Clear") this.store.clear(h.key);
  }

  async clearConversation(): Promise<void> {
    const h = this.requireFile();
    if (!h || !this.store.get(h.key).feed.length) return;
    const ok = await vscode.window.showWarningMessage(
      `Clear the conversation for ${h.file}? The graph and open interrupts stay; the assistant forgets the earlier messages.`,
      { modal: true },
      "Clear",
    );
    if (ok === "Clear") this.store.clearFeed(h.key);
  }

  /** Stop the LLM request in progress for the active file (the panel's Stop button). */
  stop(): void {
    const h = this.handle();
    if (h) this.assistant.cancel(h.key);
  }

  async beatNow(): Promise<BeatReport | undefined> {
    const h = this.requireFile();
    return h ? this.heartbeat.beat(h) : undefined;
  }

  async toggleHeartbeat(): Promise<void> {
    await this.settings().update("heartbeat.enabled", !this.heartbeatEnabled(), vscode.ConfigurationTarget.Global);
    void vscode.window.setStatusBarMessage(`Assistive heartbeat ${this.heartbeatEnabled() ? "resumed" : "paused"}`, 2500);
  }

  async exportGraph(): Promise<void> {
    const h = this.requireFile();
    const g = h && this.store.graph(h.key);
    if (!g) {
      void vscode.window.showInformationMessage("Assistive: this file has no graph yet.");
      return;
    }
    const content = `# Implementation graph: ${g.file}\n\n> ${g.moduleString.split("\n").join("\n> ")}\n\n\`\`\`mermaid\n${toMermaid(g)}\n\`\`\`\n`;
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content });
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  }

  async testConnection(): Promise<string[]> {
    const lines: string[] = [];
    if (this.llmClient) {
      try {
        const t0 = Date.now();
        const reply = await this.llmClient.text([{ role: "user", content: "Reply with the single word OK." }]);
        lines.push(`LLM ${this.config.llm.model}: ${reply.slice(0, 40) || "(empty reply)"} in ${Date.now() - t0} ms`);
        this.errors.llm = undefined;
      } catch (err) {
        this.errors.llm = (err as Error).message;
        lines.push(`LLM: ${this.errors.llm}`);
      }
    } else {
      lines.push("LLM: not configured (ASSISTIVE_LLM_API_KEY / ASSISTIVE_LLM_MODEL).");
    }
    if (this.jevClient) {
      try {
        const r = await this.jevClient.ask("A programmer typed: total = sum(prices) / len(prices)", {
          risky: { type: "noul", instructions: "Can this line raise an exception for some input?" },
        });
        const a = r.answers.risky;
        lines.push(`Jev ${r.model}: answered in ${r.latencyMs} ms (p=${a?.type === "noul" ? a.noul.toFixed(2) : "?"})`);
        this.errors.jev = undefined;
      } catch (err) {
        this.errors.jev = (err as Error).message;
        lines.push(`Jev: ${this.errors.jev}`);
      }
    } else {
      lines.push(`Jev: not configured${this.config.triage === "jev" ? " (ASSISTIVE_JEV_API_KEY)" : ` (triage is ${this.config.triage})`}.`);
    }
    this.refresh.trigger();
    return lines;
  }

  async goto(line: number, endLine?: number, rel?: string, key?: string): Promise<void> {
    let uri: vscode.Uri | undefined;
    const base = key ? vscode.workspace.textDocuments.find((d) => d.uri.fsPath === key) : this.activeDoc;
    if (rel && base) {
      const ws = this.wsFor(base.uri);
      uri = vscode.Uri.file(path.join(ws.root, ...rel.split("/")));
    } else {
      uri = base?.uri;
    }
    if (!uri) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const l = Math.min(Math.max(0, line), doc.lineCount - 1);
    const e = Math.min(Math.max(l, endLine ?? l), doc.lineCount - 1);
    const range = new vscode.Range(l, 0, e, doc.lineAt(e).text.length);
    const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private async onPanelMessage(m: FromPanel): Promise<void> {
    await this.panelMessage(m, this.activeDoc?.uri.fsPath);
  }

  private async panelMessage(m: FromPanel, key: string | undefined): Promise<void> {
    switch (m.type) {
      case "ready":
        this.refresh.trigger();
        return;
      case "send":
        return this.send(m.text);
      case "draft":
        return this.draft();
      case "sync":
        return this.sync();
      case "undo":
        return this.undo();
      case "beatNow":
        await this.beatNow();
        return;
      case "toggleHeartbeat":
        return this.toggleHeartbeat();
      case "cancel":
        return this.stop();
      case "openConfig":
        return this.openConfig();
      case "goto":
        return this.goto(m.line, m.endLine, m.path, key);
      case "openLink":
        if (/^https?:\/\//.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
      case "copy":
        await vscode.env.clipboard.writeText(m.text);
        void vscode.window.setStatusBarMessage("Copied to the clipboard", 2000);
        return;
      case "dismiss": {
        const found = this.store.findFeed(m.id);
        if (found) this.closeInterrupt(found.file, m.id, "dismissed");
        return;
      }
      case "explain": {
        const found = this.store.findFeed(m.id);
        const doc = found && vscode.workspace.textDocuments.find((d) => d.uri.fsPath === found.file);
        if (found?.item.kind === "interrupt" && doc) {
          const item = found.item;
          await this.panel.reveal();
          await this.run(() => this.assistant.explain(this.handleFor(doc), item));
        }
        return;
      }
      case "answer": {
        const found = this.store.findFeed(m.id);
        const doc = found && vscode.workspace.textDocuments.find((d) => d.uri.fsPath === found.file);
        if (found?.item.kind === "question" && doc) {
          this.store.updateFeed(found.file, m.id, { answered: m.option });
          const q = found.item.question;
          await this.run(() => this.assistant.chat(this.handleFor(doc), `Answer to "${q}": ${m.option}`));
        }
        return;
      }
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        // keep disposing the rest
      }
    }
  }
}

interface Trigger {
  trigger(): void;
  cancel(): void;
}

function debounced(fn: () => void, ms: number): Trigger {
  const d = new Debouncer(ms);
  return { trigger: () => d.trigger(fn), cancel: () => d.cancel() };
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, "\\$&");
}

function plain(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[`*_>#]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
