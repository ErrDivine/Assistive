// Invariant I1: a full session never changes a document the test did not type into.
import * as assert from "node:assert";
import * as vscode from "vscode";
import { api } from "./helpers";

describe("I1: no buffer edits", () => {
  it("no document changed except by the test's own typing", async () => {
    const a = await api();
    void a;
    const foreign = (globalThis as { __railForeignEdits?: string[] }).__railForeignEdits ?? [];
    assert.deepStrictEqual(foreign, [], `documents changed by the extension: ${foreign.join(", ")}`);
  });
});

// Installed first (mocha loads files alphabetically but this hook is global).
const typed = new Set<string>();
(globalThis as { __railTyped?: Set<string> }).__railTyped = typed;
const foreignEdits: string[] = [];
(globalThis as { __railForeignEdits?: string[] }).__railForeignEdits = foreignEdits;
vscode.workspace.onDidChangeTextDocument((e) => {
  if (e.contentChanges.length && !typed.has(e.document.uri.toString())) {
    foreignEdits.push(e.document.uri.toString());
  }
});
