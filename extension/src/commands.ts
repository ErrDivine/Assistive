// Command handlers and the "open source" helper. Nothing here edits a buffer (I1).

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Card, SourceRef } from "./types";
import { serverDirs } from "./server/ServerProcess";

export const SOURCE_SCHEME = "reference-rail-source";

/** URI that opens a card's source: a real file, or a read-only virtual document. */
export function sourceUri(src: SourceRef): vscode.Uri {
  if (src.runtime || src.path.startsWith("runtime:")) {
    const query = JSON.stringify({ path: src.path });
    return vscode.Uri.from({ scheme: SOURCE_SCHEME, path: `/${src.path.replace(":", "/")}.txt`, query });
  }
  if (src.deleted && src.commit && src.repo) {
    const query = JSON.stringify({ path: src.path, repo: src.repo, commit: src.commit, deleted: true });
    const base = path.basename(src.path);
    return vscode.Uri.from({ scheme: SOURCE_SCHEME, path: `/git/${src.commit.slice(0, 7)}/${base}`, query });
  }
  return vscode.Uri.file(src.path);
}

export async function openSource(card: Card): Promise<vscode.TextEditor> {
  const src = card.source;
  const line = Math.max(0, src.startLine - 1);
  const doc = await vscode.workspace.openTextDocument(sourceUri(src));
  // Beside the user's editor, as a preview tab, without taking focus: the
  // code being written stays visible and keeps the cursor.
  return vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    selection: new vscode.Range(line, 0, line, 0),
    preview: true,
    preserveFocus: true,
  });
}

/** What the Copy button puts on the clipboard. Clipboard only, never the buffer (I1). */
export function copyText(card: Card): string {
  if (card.snippet) {
    return card.snippet.text;
  }
  const sig = card.facts.find((f) => f.label === "signature");
  return sig ? sig.text : card.title;
}

function which(cmd: string): string | undefined {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      if (dir && fs.existsSync(p)) {
        return p;
      }
    }
  }
  return undefined;
}

function run(cmd: string, args: string[], cwd: string, log: vscode.OutputChannel): Promise<number> {
  log.appendLine(`[rail] $ ${cmd} ${args.join(" ")}  (in ${cwd})`);
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: process.env, windowsHide: true });
    p.stdout.on("data", (d) => log.append(String(d)));
    p.stderr.on("data", (d) => log.append(String(d)));
    p.on("error", (err) => {
      log.appendLine(`[rail] ${err.message}`);
      resolve(-1);
    });
    p.on("exit", (code) => resolve(code ?? -1));
  });
}

/**
 * One-time creation of the server's own virtualenv (design plan §4: the server
 * has its own environment, separate from the user's project). Uses `uv` when it
 * is on PATH, else `python3 -m venv` + pip. Downloads packages from PyPI, so it
 * only runs after the user agreed.
 */
export async function setupServerEnvironment(
  extensionPath: string,
  log: vscode.OutputChannel,
): Promise<boolean> {
  const dir = serverDirs(extensionPath)[0];
  if (!dir) {
    void vscode.window.showErrorMessage("Reference Rail: the bundled server sources were not found.");
    return false;
  }
  log.show(true);
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Reference Rail: setting up the server environment…" },
    async () => {
      const uv = which("uv");
      if (uv) {
        return (await run(uv, ["sync", "--frozen", "--no-dev"], dir, log)) === 0;
      }
      const py = which(process.platform === "win32" ? "python" : "python3");
      if (!py) {
        void vscode.window.showErrorMessage("Reference Rail: install uv or Python ≥ 3.10 to set up the server.");
        return false;
      }
      if ((await run(py, ["-m", "venv", ".venv"], dir, log)) !== 0) {
        return false;
      }
      const venvPy =
        process.platform === "win32" ? path.join(dir, ".venv", "Scripts", "python.exe") : path.join(dir, ".venv", "bin", "python");
      return (await run(venvPy, ["-m", "pip", "install", "--disable-pip-version-check", "."], dir, log)) === 0;
    },
  );
}

export async function downloadModel(
  serverPython: string,
  model: string,
  log: vscode.OutputChannel,
): Promise<boolean> {
  log.show(true);
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Reference Rail: downloading ${model}…` },
    async () => (await run(serverPython, ["-m", "rail_server", "download-model", "--model", model], process.cwd(), log)) === 0,
  );
}
