import * as assert from "node:assert";
import {
  codeBlock,
  diagnosticLevel,
  diagnosticMessage,
  escapeMarkdown,
  graphMarkdown,
  hoverMarkdown,
  interruptRange,
  lensItems,
  plain,
  plannedFileDescription,
  statusView,
} from "../../src/editor/presenters";
import type { FileGraph, GraphNode } from "../../src/types";

function node(over: Partial<GraphNode> & { id: string }): GraphNode {
  return { kind: "function", label: over.id, description: `does ${over.id}`, notes: [], status: "planned", ...over };
}

function graph(nodes: GraphNode[]): FileGraph {
  return { file: "app/main.py", language: "python", moduleString: "Fetch and cache.\n\nSecond line.", nodes, edges: [], revision: 1, updatedAt: "2000-01-01T00:00:00.000Z" };
}

const PLAN = graph([
  node({ id: "mod", kind: "module", label: "main.py" }),
  node({ id: "fetch", symbol: "fetch", signature: "def fetch(repo: str) -> list", order: 1, status: "done", line: 3 }),
  node({ id: "cache_get", symbol: "Cache.get", kind: "method", order: 2, notes: ["Return None on a miss."] }),
  node({ id: "wire", kind: "step", label: "Wire the CLI", order: 3 }),
]);

describe("presenters: markdown helpers", () => {
  it("escapeMarkdown makes Markdown characters literal", () => {
    assert.strictEqual(escapeMarkdown("a_b *c* [d](e)"), "a\\_b \\*c\\* \\[d\\]\\(e\\)");
  });

  it("plain flattens Markdown to one line without code blocks or link targets", () => {
    assert.strictEqual(plain("**Bold** `x`\n\n```py\ncode\n```\nsee [docs](https://a.b)"), "Bold x see docs");
  });

  it("codeBlock uses a fence longer than any backtick run in the code", () => {
    assert.strictEqual(codeBlock("x = 1", "python"), "```python\nx = 1\n```");
    assert.strictEqual(codeBlock("s = '```'"), "````\ns = '```'\n````");
  });
});

describe("presenters: hover", () => {
  it("shows the status, the step, the signature in a code block, the notes and the attention", () => {
    const g = graph([node({ id: "a", order: 1, status: "done" }), node({ id: "b", signature: "def b(x)", order: 2, notes: ["Edge_case"], attention: "Off *plan*" })]);
    const md = hoverMarkdown(g, g.nodes[1], "python");
    assert.match(md, /^\*\*Assistive plan\*\* · planned · step 2 of 2/);
    assert.match(md, /```python\ndef b\(x\)\n```/);
    assert.match(md, /- Edge\\_case/);
    assert.match(md, /⚠ Off \\\*plan\\\*/);
    assert.match(hoverMarkdown(g, g.nodes[0], "python"), /✓ done · step 1 of 2/);
  });
});

describe("presenters: code lens", () => {
  it("is empty without a plan", () => {
    assert.deepStrictEqual(lensItems(undefined), []);
    assert.deepStrictEqual(lensItems(graph([])), []);
    assert.deepStrictEqual(lensItems(graph([node({ id: "s", kind: "step" })])), [], "steps alone are not typed pieces");
  });

  it("shows the progress and the next piece by signature, symbol or label", () => {
    const items = lensItems(PLAN);
    assert.strictEqual(items[0].title, "$(type-hierarchy) Assistive: 1/2 done");
    assert.strictEqual(items[0].command, "assistive.focus");
    assert.strictEqual(items[1].title, "Next: Cache.get");
    assert.strictEqual(items[1].command, "assistive.showNode");
    assert.deepStrictEqual(items[1].args, ["cache_get"]);
    assert.strictEqual(items[1].tooltip, "does cache_get");
  });

  it("says when every piece is typed", () => {
    const done = graph(PLAN.nodes.map((n) => ({ ...n, status: "done" as const })));
    assert.strictEqual(lensItems(done)[1].title, "All planned pieces are typed");
  });
});

describe("presenters: status bar", () => {
  it("shows the progress, open interrupts and requests in progress", () => {
    assert.deepStrictEqual(statusView({ open: 0 }), { text: "$(type-hierarchy)", tooltip: "Assistive: implementation graph", warning: false });
    const plain = statusView({ open: 0, graph: PLAN });
    assert.strictEqual(plain.text, "$(type-hierarchy) 1/2");
    assert.strictEqual(plain.tooltip, "Assistive: 1 of 2 pieces done · next: Cache.get");
    const open = statusView({ open: 2, graph: PLAN });
    assert.strictEqual(open.text, "$(type-hierarchy) 1/2 $(warning) 2");
    assert.match(open.tooltip, /^2 open notes from the assistant\nAssistive: 1 of 2/);
    assert.strictEqual(open.warning, true);
    assert.match(statusView({ open: 1 }).tooltip, /^1 open note from/);
    const busy = statusView({ busy: "Drafting…", open: 2, graph: PLAN });
    assert.deepStrictEqual(busy, { text: "$(sync~spin) Drafting", tooltip: "Drafting…", warning: false });
  });

  it("says all done when every piece is typed", () => {
    const done = graph(PLAN.nodes.map((n) => ({ ...n, status: "done" as const })));
    assert.match(statusView({ open: 0, graph: done }).tooltip, /2 of 2 pieces done · all done$/);
  });
});

describe("presenters: interrupts", () => {
  it("underlines from the first non-blank character to the end of the last line", () => {
    assert.deepStrictEqual(interruptRange({ line: 4 }, "    total = a / b", "    total = a / b"), { startLine: 4, startCol: 4, endLine: 4, endCol: 17 });
    assert.deepStrictEqual(interruptRange({ line: 4, endLine: 6 }, "  if x:", "  return y"), { startLine: 4, startCol: 2, endLine: 6, endCol: 10 });
  });

  it("is at least one character wide on blank lines, and never ends before it starts", () => {
    assert.deepStrictEqual(interruptRange({ line: 2 }, "", ""), { startLine: 2, startCol: 0, endLine: 2, endCol: 1 });
    assert.deepStrictEqual(interruptRange({ line: 2 }, "    ", "    "), { startLine: 2, startCol: 4, endLine: 2, endCol: 5 });
    assert.strictEqual(interruptRange({ line: 5, endLine: 3 }, "x", "y").endLine, 5);
  });

  it("maps severity to a diagnostic level and the message to plain text", () => {
    assert.strictEqual(diagnosticLevel(3), "error");
    assert.strictEqual(diagnosticLevel(2), "warning");
    assert.strictEqual(diagnosticLevel(1), "information");
    assert.strictEqual(diagnosticMessage({ title: "Division by zero", message: "`b` can be **0**." }), "Division by zero: b can be 0.");
  });
});

describe("presenters: planned files and export", () => {
  it("describes a planned file by its progress and next piece", () => {
    assert.strictEqual(plannedFileDescription(PLAN), "1/2 done · next: Cache.get");
    assert.strictEqual(plannedFileDescription(graph([node({ id: "s", kind: "step" })])), "");
  });

  it("exports the docstring, the progress, a Mermaid chart and a step checklist", () => {
    const md = graphMarkdown(PLAN);
    assert.match(md, /^# Implementation graph: app\/main\.py\n\n> Fetch and cache\.\n> \n> Second line\.\n/);
    assert.match(md, /Progress: 1 of 2 pieces typed\. Next: `Cache\.get`\./);
    assert.match(md, /```mermaid\nflowchart TD\n/);
    assert.match(md, /## Steps\n\n1\. \[x\] \*\*fetch\*\* \(function\) · `def fetch\(repo: str\) -> list`\n {3}does fetch\n/);
    assert.match(md, /2\. \[ \] \*\*cache_get\*\* \(method\)\n {3}does cache_get\n {3}- Return None on a miss\.\n/);
    assert.match(md, /3\. \[ \] \*\*Wire the CLI\*\* \(step\)/);
    assert.ok(!/\(module\)/.test(md), "the module node is not a step");
  });

  it("keeps each step on its own lines and neutralises HTML", () => {
    const md = graphMarkdown(graph([node({ id: "x", description: "Line one\nline two <script>", notes: ["a\n\nb"], signature: "f(`x`)" })]));
    assert.match(md, /\n {3}Line one line two &lt;script>\n {3}- a b\n/);
    assert.match(md, /`f\('x'\)`/);
    assert.ok(!/Progress:/.test(graphMarkdown(graph([node({ id: "s", kind: "step" })]))), "no progress line without typed pieces");
  });
});
