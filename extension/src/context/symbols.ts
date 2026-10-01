// Definition / hover / enclosing-scope resolution helpers (design plan §9.1).

import * as vscode from "vscode";
import type { SourceLoc } from "../types";

export { isKeyword, lineIdentifiers, pythonEnclosingRange } from "./pyscope";

export const LOOKUP_TIMEOUT_MS = 150;

/** Resolve within ``ms`` or give up with ``undefined`` (never rejects). */
export function within<T>(p: Thenable<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

function toLoc(item: vscode.Location | vscode.LocationLink | undefined): SourceLoc | undefined {
  if (!item) {
    return undefined;
  }
  const uri = "targetUri" in item ? item.targetUri : item.uri;
  const range =
    "targetUri" in item ? (item.targetSelectionRange ?? item.targetRange) : item.range;
  if (uri.scheme !== "file") {
    return undefined;
  }
  return { path: uri.fsPath, line: range.start.line, character: range.start.character };
}

export async function definitionAt(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  deadline: Promise<void>,
): Promise<SourceLoc | undefined> {
  const res = await Promise.race([
    Promise.resolve(
      vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | vscode.Location>(
        "vscode.executeDefinitionProvider",
        doc.uri,
        pos,
      ),
    ).catch(() => undefined),
    deadline.then(() => undefined),
  ]);
  const first = Array.isArray(res) ? res[0] : res;
  return toLoc(first);
}

export async function hoverAt(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  deadline: Promise<void>,
): Promise<string | undefined> {
  const res = await Promise.race([
    Promise.resolve(
      vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", doc.uri, pos),
    ).catch(() => undefined),
    deadline.then(() => undefined),
  ]);
  if (!res || res.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  for (const hover of res) {
    for (const c of hover.contents) {
      parts.push(typeof c === "string" ? c : c.value);
    }
  }
  const text = parts.join("\n").trim();
  return text ? text.slice(0, 2000) : undefined;
}

const SCOPE_KINDS = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Constructor,
]);

export async function enclosingSymbolRange(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  deadline: Promise<void>,
): Promise<vscode.Range | undefined> {
  const res = await Promise.race([
    Promise.resolve(
      vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
        "vscode.executeDocumentSymbolProvider",
        doc.uri,
      ),
    ).catch(() => undefined),
    deadline.then(() => undefined),
  ]);
  if (!res || res.length === 0) {
    return undefined;
  }
  let best: vscode.Range | undefined;
  const visit = (symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[]) => {
    for (const s of symbols) {
      const range = "range" in s ? s.range : s.location.range;
      if (!range.contains(pos)) {
        continue;
      }
      if (SCOPE_KINDS.has(s.kind) && (!best || best.contains(range))) {
        best = range;
      }
      if ("children" in s && s.children?.length) {
        visit(s.children);
      }
    }
  };
  visit(res);
  return best;
}
