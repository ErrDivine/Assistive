import * as assert from "node:assert";
import * as path from "node:path";
import {
  cleandoc,
  formatOutline,
  jsModuleString,
  normalizeSignature,
  outline,
  pythonModuleString,
  pythonOutlineRegex,
  symbolAt,
} from "../../src/code/outline";
import { TreeSitter } from "../../src/code/treesitter";

const WASM = path.resolve(__dirname, "../../../node_modules/@vscode/tree-sitter-wasm/wasm");
const ts = new TreeSitter(WASM);

const PY = `#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Fetch GitHub issues for a repo and cache them on disk.

    Uses ETags to avoid refetching.
"""
from __future__ import annotations
import os, json as j
from .cache import Cache
from ..util.http import get

MAX_PAGES = 10
logger = make_logger()
__all__ = ["fetch"]

@dataclass
class Issue:
    """One issue."""
    number: int

    def title_short(self, n: int = 20) -> str:
        """Shorten the title."""
        ...

    async def load(
        self,
        path: str,
    ) -> "Issue":
        raise NotImplementedError("later")

def fetch(repo: str) -> list[Issue]:  # todo
    pass

def real(x):
    def inner():
        return 1
    return x + inner()
`;

describe("module strings", () => {
  it("reads a closed Python docstring after a shebang and comments, dedented", () => {
    const m = pythonModuleString(PY)!;
    assert.strictEqual(m.closed, true);
    assert.strictEqual(m.text, "Fetch GitHub issues for a repo and cache them on disk.\n\nUses ETags to avoid refetching.");
    assert.strictEqual(m.startLine, 2);
    assert.strictEqual(m.endLine, 5);
  });

  it("reports a docstring that is still being typed as open", () => {
    const m = pythonModuleString('"""Parse the config file\n\nand validate')!;
    assert.strictEqual(m.closed, false);
    assert.strictEqual(m.text, "Parse the config file\n\nand validate");
  });

  it("handles single-quoted, raw and one-line docstrings", () => {
    assert.deepStrictEqual(pythonModuleString("r'''Raw doc.'''\nx = 1")?.text, "Raw doc.");
    assert.strictEqual(pythonModuleString('"Short doc."\n')?.closed, true);
    assert.strictEqual(pythonModuleString('"Short doc \\" with quote"\n')?.text, 'Short doc \\" with quote');
    assert.strictEqual(pythonModuleString('"unterminated\nx = 1')?.closed, false);
  });

  it("ignores files that do not start with a string", () => {
    assert.strictEqual(pythonModuleString("import os\n'''not a docstring'''"), undefined);
    assert.strictEqual(pythonModuleString(""), undefined);
  });

  it("reads a JSDoc block, stripping the stars", () => {
    const m = jsModuleString("#!/usr/bin/env node\n/**\n * Rate limiter.\n *\n * Token bucket.\n */\nexport {};")!;
    assert.strictEqual(m.text, "Rate limiter.\n\nToken bucket.");
    assert.strictEqual(m.closed, true);
    assert.strictEqual(m.startLine, 1);
    assert.strictEqual(m.endLine, 5);
  });

  it("treats an unterminated block comment as open", () => {
    assert.strictEqual(jsModuleString("/** Rate limiter for")?.closed, false);
  });

  it("reads a run of // comments, closed once code or an empty line follows", () => {
    assert.strictEqual(jsModuleString("// Counts words\n// in files\n")?.closed, false);
    assert.strictEqual(jsModuleString("// Counts words\n// in files\n\n")?.closed, true);
    assert.strictEqual(jsModuleString("// Counts words\nconst x = 1;")?.closed, true);
    assert.strictEqual(jsModuleString('"use strict";\n// Counts words\n\n')?.text, "Counts words");
  });

  it("cleandoc follows inspect.cleandoc", () => {
    assert.strictEqual(cleandoc("  First.\n\n      indented\n    less\n  "), "First.\n\n  indented\nless");
  });
});

describe("outline (tree-sitter)", () => {
  it("lists Python classes, methods, functions and constants with signatures and stubs", async () => {
    const o = await outline(ts, "python", PY);
    assert.strictEqual(o.parser, "tree-sitter");
    assert.strictEqual(o.hasErrors, false);
    const by = Object.fromEntries(o.symbols.map((s) => [s.qualname, s]));
    assert.deepStrictEqual(Object.keys(by), ["MAX_PAGES", "logger", "Issue", "Issue.title_short", "Issue.load", "fetch", "real"]);
    assert.strictEqual(by.MAX_PAGES.kind, "constant");
    assert.strictEqual(by.logger.kind, "variable");
    assert.strictEqual(by.Issue.kind, "class");
    assert.strictEqual(by.Issue.line, 15, "decorators belong to the class");
    assert.strictEqual(by.Issue.docstring, "One issue.");
    assert.strictEqual(by["Issue.title_short"].kind, "method");
    assert.strictEqual(by["Issue.title_short"].parent, "Issue");
    assert.strictEqual(by["Issue.title_short"].signature, "def title_short(self, n: int = 20) -> str");
    assert.strictEqual(by["Issue.title_short"].isStub, true);
    assert.strictEqual(by["Issue.load"].signature, 'async def load(self, path: str) -> "Issue"');
    assert.strictEqual(by["Issue.load"].isStub, true);
    assert.strictEqual(by.fetch.signature, "def fetch(repo: str) -> list[Issue]", "comments are not part of signatures");
    assert.strictEqual(by.fetch.isStub, true);
    assert.strictEqual(by.real.isStub, false);
    assert.ok(!o.symbols.some((s) => s.name === "inner"), "nested functions are not listed");
    assert.deepStrictEqual(o.imports, ["__future__", "os", "json", ".cache", "..util.http"]);
  });

  it("lists TypeScript functions, classes, members, arrow functions and types", async () => {
    const src = `/**
 * Rate limiter for outgoing requests.
 */
import { a } from "./b";
export * from "./c";

/** Make a limiter. */
export function make(n: number): Limiter {
  throw new Error("Not implemented");
}
export class Limiter {
  /** Take a token. */
  take(): boolean { return true; }
  run = async (f: () => void) => {};
}
export const MAX = 3;
const helper = (a: number): number => a * 2;
export interface Opts { n: number }
type Id = string;
`;
    const o = await outline(ts, "typescript", src);
    const by = Object.fromEntries(o.symbols.map((s) => [s.qualname, s]));
    assert.deepStrictEqual(Object.keys(by), ["make", "Limiter", "Limiter.take", "Limiter.run", "MAX", "helper", "Opts", "Id"]);
    assert.strictEqual(by.make.isStub, true);
    assert.strictEqual(by.make.docstring, "Make a limiter.");
    assert.strictEqual(by.make.signature, "export function make(n: number): Limiter".replace("export ", ""));
    assert.strictEqual(by["Limiter.take"].isStub, false);
    assert.strictEqual(by["Limiter.take"].docstring, "Take a token.");
    assert.strictEqual(by["Limiter.run"].isStub, true, "an empty arrow body is a stub");
    assert.strictEqual(by.MAX.kind, "constant");
    assert.strictEqual(by.helper.kind, "function");
    assert.strictEqual(by.helper.isStub, false);
    assert.strictEqual(by.Opts.kind, "type");
    assert.deepStrictEqual(o.imports, ["./b", "./c"]);
    assert.strictEqual(o.moduleString?.text, "Rate limiter for outgoing requests.");
  });

  it("does not use the module comment as the first function's doc", async () => {
    const o = await outline(ts, "javascript", "/** Module doc. */\nfunction f() {}\n");
    assert.strictEqual(o.symbols[0].docstring, undefined);
    assert.strictEqual(o.symbols[0].isStub, true);
  });

  it("still outlines code with syntax errors and says so", async () => {
    const o = await outline(ts, "python", '"""Doc."""\ndef ok(a):\n    return a\n\ndef broken(:\n');
    assert.strictEqual(o.hasErrors, true);
    assert.ok(o.symbols.some((s) => s.name === "ok"));
  });

  it("returns an empty outline for unsupported languages", async () => {
    const o = await outline(ts, "rust", "fn main() {}");
    assert.strictEqual(o.parser, "none");
    assert.deepStrictEqual(o.symbols, []);
  });

  it("falls back to the regex outline when no parser is available", async () => {
    const o = await outline(undefined, "python", PY);
    assert.strictEqual(o.parser, "regex");
    assert.deepStrictEqual(
      o.symbols.map((s) => s.qualname),
      ["MAX_PAGES", "Issue", "Issue.title_short", "Issue.load", "fetch", "real"],
    );
  });
});

describe("regex outline", () => {
  it("matches the tree-sitter signatures and stub detection", () => {
    const syms = pythonOutlineRegex(PY);
    const by = Object.fromEntries(syms.map((s) => [s.qualname, s]));
    assert.strictEqual(by["Issue.load"].signature, 'async def load(self, path: str) -> "Issue"');
    assert.strictEqual(by.fetch.signature, "def fetch(repo: str) -> list[Issue]");
    assert.strictEqual(by["Issue.title_short"].docstring, "Shorten the title.");
    assert.strictEqual(by["Issue.title_short"].isStub, true);
    assert.strictEqual(by.real.isStub, false);
    assert.strictEqual(by.Issue.line, 15);
  });
});

describe("outline helpers", () => {
  it("symbolAt picks the innermost symbol", async () => {
    const o = await outline(ts, "python", PY);
    assert.strictEqual(symbolAt(o, 27)?.qualname, "Issue.load");
    assert.strictEqual(symbolAt(o, 17)?.qualname, "Issue");
    assert.strictEqual(symbolAt(o, 0), undefined);
  });

  it("formatOutline renders 1-based ranges, stubs and docstrings", async () => {
    const o = await outline(ts, "python", PY);
    const text = formatOutline(o, { docstrings: true });
    assert.match(text, /^imports: __future__, os, json/);
    assert.match(text, /\n {2}L21-23 def title_short\(self, n: int = 20\) -> str {2}\[stub\]/);
    assert.match(text, /"Shorten the title\."/);
    assert.match(formatOutline({ ...o, symbols: [], imports: [] }), /no symbols yet/);
  });

  it("normalizeSignature collapses multi-line headers", () => {
    assert.strictEqual(normalizeSignature("def f(\n    a,\n    b,\n) -> int:"), "def f(a, b) -> int");
    assert.strictEqual(normalizeSignature("function g(a: string) {"), "function g(a: string)");
  });
});
