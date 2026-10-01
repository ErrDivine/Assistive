import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { RailApi } from "../../src/extension";

export const FIXTURES = process.env.RAIL_FIXTURES ?? path.resolve(__dirname, "../../../../eval/fixtures");

export async function api(): Promise<RailApi> {
  const ext = vscode.extensions.getExtension<RailApi>("errdivine.reference-rail");
  assert.ok(ext, "extension not found");
  return ext.isActive ? ext.exports : ext.activate();
}

export async function waitFor<T>(
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 30_000,
  what = "condition",
  stepMs = 100,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) {
      return v;
    }
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(stepMs);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitRunning(a: RailApi, timeoutMs = 60_000): Promise<void> {
  await waitFor(() => a.server.state === "running" && a.server.rail, timeoutMs, "server running");
}

/** Wait until the background sync finished and libraries are indexed. */
export async function waitIndexed(a: RailApi, timeoutMs = 240_000): Promise<void> {
  await waitRunning(a);
  await sleep(500);
  await waitFor(
    async () => {
      const s = await a.server.rail?.status().catch(() => undefined);
      return s && !s.syncing && s.dists > 0 && s.chunks > 0;
    },
    timeoutMs,
    "index sync",
    500,
  );
}

export function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders![0].uri.fsPath;
}

/** Write a file into the fixture workspace (test setup, not an editor edit). */
export function writeWorkspaceFile(rel: string, text: string): string {
  const p = path.join(workspaceRoot(), rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

export async function openAt(file: string, find: string, offset: number, occurrence = 1): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  let seen = 0;
  for (let i = 0; i < doc.lineCount; i++) {
    const col = doc.lineAt(i).text.indexOf(find);
    if (col >= 0 && ++seen === occurrence) {
      const pos = new vscode.Position(i, col + offset);
      editor.selection = new vscode.Selection(pos, pos);
      return editor;
    }
  }
  throw new Error(`${find} not found in ${file}`);
}

export function fixturePython(): string {
  return process.platform === "win32"
    ? path.join(FIXTURES, ".venv", "Scripts", "python.exe")
    : path.join(FIXTURES, ".venv", "bin", "python");
}

/** What `pip show <dist>` would report for the fixture venv. */
export function installedVersion(dist: string): string {
  return execFileSync(fixturePython(), [
    "-c",
    `import importlib.metadata as m; print(m.version(${JSON.stringify(dist)}))`,
  ])
    .toString()
    .trim();
}

export function sitePackagesFile(rel: string): string {
  const out = execFileSync(fixturePython(), [
    "-c",
    "import sysconfig; print(sysconfig.get_paths()['purelib'])",
  ])
    .toString()
    .trim();
  return path.join(out, rel);
}

export function lineOf(file: string, needle: string): number {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes(needle));
  assert.ok(i >= 0, `${needle} not in ${file}`);
  return i;
}
