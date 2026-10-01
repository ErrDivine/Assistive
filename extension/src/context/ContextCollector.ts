// Context Collector (design plan §9.1): turns editor events into debounced ContextFrames.

import * as vscode from "vscode";
import type { ContextFrame, SourceLoc, Trigger } from "../types";
import { Debouncer, fitLines, Ring } from "./debounce";
import {
  definitionAt,
  enclosingSymbolRange,
  hoverAt,
  isKeyword,
  lineIdentifiers,
  LOOKUP_TIMEOUT_MS,
  pythonEnclosingRange,
} from "./symbols";

export const CURSOR_DEBOUNCE_MS = 350;
export const EDIT_DEBOUNCE_MS = 800;
export const DIAGNOSTIC_DEBOUNCE_MS = 300;
const FALLBACK_CONTEXT_LINES = 40;
const MAX_ENCLOSING_BYTES = 4096;
const DIAGNOSTIC_RADIUS = 5;

export interface CollectorHooks {
  /** Called with every frame to send. */
  onFrame(frame: ContextFrame): void;
  /** Called on every edit (stale queries should be cancelled). */
  onEdit(doc: vscode.TextDocument): void;
  onSave(doc: vscode.TextDocument): void;
  enabled(): boolean;
}

export function isRailDocument(doc: vscode.TextDocument | undefined): doc is vscode.TextDocument {
  return !!doc && doc.uri.scheme === "file" && doc.languageId === "python";
}

export class ContextCollector implements vscode.Disposable {
  private requestId = 0;
  private readonly cursor = new Debouncer(CURSOR_DEBOUNCE_MS);
  private readonly editDebounce = new Debouncer(EDIT_DEBOUNCE_MS);
  private readonly diag = new Debouncer(DIAGNOSTIC_DEBOUNCE_MS);
  private readonly edits = new Map<string, Ring<{ line: number; text: string; ts: number }>>();
  private lastEditAt = 0;
  private lastDiagKey = "";
  private explicitAt?: { uri: string; line: number; character: number };
  private readonly disposables: vscode.Disposable[] = [];
  /** Wall time of the last edit in any Python document. */
  lastEditTime = 0;

  constructor(private readonly hooks: CollectorHooks) {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => this.timed(() => this.onSelection(e))),
      vscode.workspace.onDidChangeTextDocument((e) => this.timed(() => this.onDocChange(e))),
      vscode.languages.onDidChangeDiagnostics((e) => this.timed(() => this.onDiagnostics(e))),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (isRailDocument(doc)) {
          this.hooks.onSave(doc);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.cursor.cancel();
        this.editDebounce.cancel();
        this.diag.cancel();
      }),
    );
  }

  /** Longest synchronous handler run so far, in ms (typing-stress budget: 50 ms). */
  maxSyncMs = 0;

  private timed(fn: () => void): void {
    const t0 = performance.now();
    try {
      fn();
    } finally {
      this.maxSyncMs = Math.max(this.maxSyncMs, performance.now() - t0);
    }
  }

  get lastRequestId(): number {
    return this.requestId;
  }

  /** Allocate a request id (ids must strictly increase per session). */
  nextRequestId(): number {
    return ++this.requestId;
  }

  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.hooks.enabled() || !isRailDocument(e.textEditor.document)) {
      return;
    }
    // Selection moves caused by typing are covered by the edit_pause trigger.
    if (e.kind === undefined && Date.now() - this.lastEditAt < 100) {
      return;
    }
    if (e.kind === vscode.TextEditorSelectionChangeKind.Command && Date.now() - this.lastEditAt < 100) {
      return;
    }
    const editor = e.textEditor;
    // An explicit answer stays until the cursor actually moves elsewhere.
    const pos = editor.selection.active;
    const ex = this.explicitAt;
    if (ex && ex.uri === editor.document.uri.toString() && ex.line === pos.line && ex.character === pos.character) {
      return;
    }
    this.explicitAt = undefined;
    this.cursor.trigger(() => void this.fire(editor, "cursor_pause"));
  }

  private onDocChange(e: vscode.TextDocumentChangeEvent): void {
    if (!isRailDocument(e.document) || e.contentChanges.length === 0) {
      return;
    }
    const now = Date.now();
    this.lastEditAt = now;
    this.lastEditTime = now;
    const key = e.document.uri.toString();
    let ring = this.edits.get(key);
    if (!ring) {
      ring = new Ring(10);
      this.edits.set(key, ring);
    }
    for (const change of e.contentChanges) {
      const line = change.range.start.line;
      if (line < e.document.lineCount) {
        const items = ring.toArray();
        const last = items[items.length - 1];
        const entry = { line, text: e.document.lineAt(line).text, ts: now };
        if (last && last.line === line) {
          ring.clear();
          for (const it of items.slice(0, -1)) {
            ring.push(it);
          }
        }
        ring.push(entry);
      }
    }
    this.hooks.onEdit(e.document);
    this.cursor.cancel();
    if (!this.hooks.enabled()) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === e.document) {
      this.editDebounce.trigger(() => void this.fire(editor, "edit_pause"));
    }
  }

  private onDiagnostics(e: vscode.DiagnosticChangeEvent): void {
    const editor = vscode.window.activeTextEditor;
    if (!this.hooks.enabled() || !editor || !isRailDocument(editor.document)) {
      return;
    }
    const uri = editor.document.uri.toString();
    if (!e.uris.some((u) => u.toString() === uri)) {
      return;
    }
    const near = this.nearbyDiagnostics(editor);
    const key = near.map((d) => `${d.line}:${d.message}`).join("\n");
    if (key === this.lastDiagKey) {
      return;
    }
    this.lastDiagKey = key;
    if (near.length > 0) {
      this.diag.trigger(() => void this.fire(editor, "diagnostic"));
    }
  }

  private nearbyDiagnostics(editor: vscode.TextEditor): ContextFrame["diagnostics"] {
    const line = editor.selection.active.line;
    return vscode.languages
      .getDiagnostics(editor.document.uri)
      .filter((d) => Math.abs(d.range.start.line - line) <= DIAGNOSTIC_RADIUS)
      .slice(0, 10)
      .map((d) => ({
        message: d.message,
        line: d.range.start.line,
        source: d.source,
      }));
  }

  /** Explicit trigger (no debounce). Returns the frame that was sent. */
  async ask(question?: string): Promise<ContextFrame | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isRailDocument(editor.document)) {
      return undefined;
    }
    this.cursor.cancel();
    this.editDebounce.cancel();
    const pos = editor.selection.active;
    this.explicitAt = { uri: editor.document.uri.toString(), line: pos.line, character: pos.character };
    return this.fire(editor, "explicit", question);
  }

  private async fire(
    editor: vscode.TextEditor,
    trigger: Trigger,
    question?: string,
  ): Promise<ContextFrame | undefined> {
    if (trigger !== "explicit" && !this.hooks.enabled()) {
      return undefined;
    }
    const frame = await this.buildFrame(editor, trigger, question);
    // A newer frame may have been built while we awaited lookups.
    if (frame.requestId !== this.requestId) {
      return undefined;
    }
    this.hooks.onFrame(frame);
    return frame;
  }

  async buildFrame(
    editor: vscode.TextEditor,
    trigger: Trigger,
    question?: string,
  ): Promise<ContextFrame> {
    const requestId = this.nextRequestId();
    const doc = editor.document;
    const pos = editor.selection.active;
    const deadline = new Promise<void>((r) => setTimeout(r, LOOKUP_TIMEOUT_MS));

    const wordRange = doc.getWordRangeAtPosition(pos, /[A-Za-z_][A-Za-z0-9_]*/);
    const word = wordRange ? doc.getText(wordRange) : undefined;
    const lineText = doc.lineAt(pos.line).text;
    const symbolWanted = word && !isKeyword(word) && !/^\d/.test(word);

    const nearby = lineIdentifiers(lineText, word).filter(
      (n) => !wordRange || n.character < wordRange.start.character || n.character >= wordRange.end.character,
    );
    const [scope, definition, hoverText, nearbyLocs] = await Promise.all([
      enclosingSymbolRange(doc, pos, deadline),
      symbolWanted ? definitionAt(doc, wordRange!.start, deadline) : Promise.resolve(undefined),
      symbolWanted ? hoverAt(doc, wordRange!.start, deadline) : Promise.resolve(undefined),
      Promise.all(
        nearby.map((n) => definitionAt(doc, new vscode.Position(pos.line, n.character), deadline)),
      ),
    ]);

    // Enclosing def/class (symbol provider, else indentation), else ±40 lines.
    let start: number;
    let end: number;
    if (scope) {
      start = scope.start.line;
      end = scope.end.line;
    } else {
      const lines: string[] = [];
      const lo = Math.max(0, pos.line - 400);
      const hi = Math.min(doc.lineCount - 1, pos.line + 400);
      for (let i = lo; i <= hi; i++) {
        lines.push(doc.lineAt(i).text);
      }
      const r = pythonEnclosingRange(lines, pos.line - lo);
      if (r) {
        start = r[0] + lo;
        end = r[1] + lo;
      } else {
        start = Math.max(0, pos.line - FALLBACK_CONTEXT_LINES);
        end = Math.min(doc.lineCount - 1, pos.line + FALLBACK_CONTEXT_LINES);
      }
    }
    const scopeLines: string[] = [];
    for (let i = start; i <= end; i++) {
      scopeLines.push(doc.lineAt(i).text);
    }
    const [lo, hi] = fitLines(scopeLines, pos.line - start, MAX_ENCLOSING_BYTES);
    const enclosingText = scopeLines.slice(lo, hi + 1).join("\n");

    const seen = new Set<string>();
    const nearbyDefinitions: SourceLoc[] = [];
    for (const loc of nearbyLocs) {
      if (!loc) {
        continue;
      }
      const k = `${loc.path}:${loc.line}`;
      if (!seen.has(k)) {
        seen.add(k);
        nearbyDefinitions.push(loc);
      }
    }

    const frame: ContextFrame = {
      requestId,
      trigger,
      docUri: doc.uri.toString(),
      languageId: doc.languageId,
      cursor: { line: pos.line, character: pos.character },
      enclosingText,
      enclosingRange: { startLine: start + lo, endLine: start + hi },
      nearbyDefinitions: nearbyDefinitions.slice(0, 5),
      recentEdits: (this.edits.get(doc.uri.toString())?.toArray() ?? []).slice(-10),
      diagnostics: this.nearbyDiagnostics(editor),
    };
    if (symbolWanted && word) {
      frame.symbolAtCursor = { text: word };
      if (definition) {
        frame.symbolAtCursor.definition = definition;
      }
      if (hoverText) {
        frame.symbolAtCursor.hoverText = hoverText;
      }
    }
    if (question) {
      frame.explicitQuestion = question;
    }
    return frame;
  }

  dispose(): void {
    this.cursor.cancel();
    this.editDebounce.cancel();
    this.diag.cancel();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
