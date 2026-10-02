// WorkspaceAccess over the VS Code API: open buffers win over disk, so the
// assistant sees unsaved typing.

import * as path from "node:path";
import * as vscode from "vscode";
import { type DiagnosticInfo, EXCLUDE_GLOB, type SearchHit, type WorkspaceAccess } from "./context";

const LANG_BY_EXT: Record<string, string> = {
  ".py": "python",
  ".pyi": "python",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
};

const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|bz2|xz|7z|tar|whl|egg|so|dylib|dll|exe|bin|class|jar|pyc|pyo|o|a|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|sqlite3?|db|npy|npz|pkl|parquet|h5|onnx|pt|ckpt|lock)$/i;

const MAX_FILE_BYTES = 1_000_000;
const SEARCH_FILE_LIMIT = 4000;

const SEVERITY: Record<vscode.DiagnosticSeverity, DiagnosticInfo["severity"]> = {
  [vscode.DiagnosticSeverity.Error]: "error",
  [vscode.DiagnosticSeverity.Warning]: "warning",
  [vscode.DiagnosticSeverity.Information]: "info",
  [vscode.DiagnosticSeverity.Hint]: "hint",
};

export class VsWorkspace implements WorkspaceAccess {
  constructor(
    readonly root: string,
    /** Diagnostics from this source (our own interrupts) are left out. */
    private readonly ownSource = "Assistive",
  ) {}

  private rel(uri: vscode.Uri): string {
    return path.relative(this.root, uri.fsPath).split(path.sep).join("/");
  }

  private abs(rel: string): string {
    return path.join(this.root, ...rel.split("/"));
  }

  async list(glob = "**/*", max = 200): Promise<string[]> {
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(this.root, glob), EXCLUDE_GLOB, max);
    return uris.map((u) => this.rel(u)).sort();
  }

  async read(rel: string): Promise<string | undefined> {
    const abs = this.abs(rel);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme !== "git" && d.uri.fsPath === abs);
    if (open) {
      return open.getText();
    }
    try {
      const uri = vscode.Uri.file(abs);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) {
        return undefined;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      const head = bytes.subarray(0, Math.min(bytes.length, MAX_FILE_BYTES));
      if (head.subarray(0, 2000).includes(0)) {
        return "(binary file)";
      }
      const text = new TextDecoder().decode(head);
      return bytes.length > MAX_FILE_BYTES ? `${text}\n…(file truncated at 1 MB)` : text;
    } catch {
      return undefined;
    }
  }

  async search(query: string, opts: { regex: boolean; glob?: string; max: number }): Promise<SearchHit[]> {
    const re = opts.regex ? new RegExp(query) : undefined;
    const files = (await this.list(opts.glob ?? "**/*", SEARCH_FILE_LIMIT)).filter((f) => !BINARY_EXT.test(f));
    const hits: SearchHit[] = [];
    for (const rel of files) {
      const text = await this.read(rel);
      if (!text || text === "(binary file)") {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re ? re.test(lines[i]) : lines[i].includes(query)) {
          hits.push({ path: rel, line: i, text: lines[i] });
          if (hits.length >= opts.max) {
            return hits;
          }
        }
      }
    }
    return hits;
  }

  diagnostics(rel?: string): DiagnosticInfo[] {
    const entries: [vscode.Uri, readonly vscode.Diagnostic[]][] = rel
      ? [[vscode.Uri.file(this.abs(rel)), vscode.languages.getDiagnostics(vscode.Uri.file(this.abs(rel)))]]
      : vscode.languages.getDiagnostics();
    const out: DiagnosticInfo[] = [];
    for (const [uri, diags] of entries) {
      const r = this.rel(uri);
      if (r.startsWith("..")) {
        continue;
      }
      for (const d of diags) {
        if (d.source === this.ownSource) {
          continue;
        }
        out.push({ path: r, line: d.range.start.line, severity: SEVERITY[d.severity], message: d.message, source: d.source });
      }
    }
    return out.sort((a, b) => (a.severity === b.severity ? a.line - b.line : a.severity === "error" ? -1 : 1));
  }

  languageOf(rel: string): string | undefined {
    return LANG_BY_EXT[path.extname(rel).toLowerCase()];
  }
}
