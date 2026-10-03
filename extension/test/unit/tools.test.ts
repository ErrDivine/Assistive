import * as assert from "node:assert";
import * as path from "node:path";
import { EditTracker } from "../../src/code/changes";
import { outline } from "../../src/code/outline";
import { TreeSitter } from "../../src/code/treesitter";
import { emptyGraph, GraphEditor } from "../../src/graph/model";
import type { AgentTool, ToolContext } from "../../src/llm/agent";
import { check } from "../../src/llm/schema";
import { type ToolEnv, toolsFor } from "../../src/llm/tools";
import type { FeedItem, NewFeedItem, Resource } from "../../src/types";
import type { ToolMode } from "../../src/llm/tools";
import { MemoryWorkspace } from "../support/memoryWorkspace";

const ts = new TreeSitter(path.resolve(__dirname, "../../../node_modules/@vscode/tree-sitter-wasm/wasm"));

const APP = `"""Word counter."""
from .util import tokenize


def count(text: str) -> dict[str, int]:
    words = tokenize(text)
    return {w: words.count(w) for w in words}


def top(counts):
    pass
`;

function setup(mode: ToolMode, live = APP, feed: FeedItem[] = []) {
  const ws = new MemoryWorkspace({
    "app/main.py": APP,
    "app/util.py": '"""Helpers."""\ndef tokenize(text: str) -> list[str]:\n    return text.split()\n',
    "app/.env": "SECRET=1",
    "README.md": "# Demo\n",
  });
  ws.diags = [{ path: "app/main.py", line: 9, severity: "warning", message: "missing type annotation", source: "pyright" }];
  const emitted: NewFeedItem[] = [];
  const edits = new EditTracker();
  edits.open("app/main.py", APP);
  const env: ToolEnv = {
    ws,
    file: "app/main.py",
    language: "python",
    liveText: () => live,
    outlineOf: (rel, text) => outline(ts, rel.endsWith(".py") ? "python" : "plaintext", text),
    editor: new GraphEditor(emptyGraph("app/main.py", "python", "Word counter.")),
    edits,
    checkLinks: async (items: Resource[]) => ({
      kept: items.filter((r) => !r.url.includes("missing")).map((r) => ({ ...r, verified: "ok" as const })),
      dropped: items.filter((r) => r.url.includes("missing")).map((r) => ({ url: r.url, reason: "HTTP 404" })),
    }),
    emit: (i) => {
      // Like the Assistant: an open interrupt on the same line text is not repeated.
      if (
        i.kind === "interrupt" &&
        feed.some((f) => f.kind === "interrupt" && f.status !== "resolved" && f.issue === i.issue && f.lineText?.trim() === i.lineText?.trim())
      ) {
        return false;
      }
      emitted.push(i);
      return true;
    },
    feed: () => feed,
  };
  const tools = new Map(toolsFor(mode, env).map((t) => [t.name, t]));
  const ctx: ToolContext = {};
  const call = async (name: string, args: unknown): Promise<string> => {
    const t = tools.get(name) as AgentTool | undefined;
    assert.ok(t, `tool ${name} is available in ${mode}`);
    const c = check(args, t.parameters);
    assert.deepStrictEqual(c.errors, [], `valid args for ${name}`);
    return t.run(c.value as Record<string, unknown>, ctx);
  };
  return { env, ws, emitted, tools, call, ctx, edits };
}

describe("tool sets", () => {
  it("give each mode the right tools", () => {
    const names = (m: ToolMode) => toolsFor(m, setup(m).env).map((t) => t.name);
    const look = ["get_file_outline", "read_file", "read_symbol", "search_code", "list_files", "get_diagnostics"];
    const edit = ["add_nodes", "update_nodes", "remove_nodes", "connect", "disconnect"];
    assert.deepStrictEqual(names("draft"), [...look, "get_graph", ...edit, "recommend_resources", "ask_programmer"]);
    assert.deepStrictEqual(names("chat"), [
      ...look,
      "get_project_context",
      "get_graph",
      "get_recent_edits",
      ...edit,
      "recommend_resources",
      "ask_programmer",
      "point_to_code",
    ]);
    assert.deepStrictEqual(names("sync"), [...look, "get_project_context", "get_graph", "get_recent_edits", ...edit]);
    assert.deepStrictEqual(names("heartbeat"), [
      ...look,
      "get_project_context",
      "get_graph",
      "get_recent_edits",
      "update_nodes",
      "recommend_resources",
      "interrupt_programmer",
      "stand_down",
    ]);
    // A struggle turn only offers resources: no interrupts, no graph changes.
    assert.deepStrictEqual(names("struggling"), [...look, "get_project_context", "get_graph", "get_recent_edits", "recommend_resources"]);
  });

  it("have descriptions and object schemas that forbid unknown fields", () => {
    for (const mode of ["draft", "chat", "sync", "heartbeat", "struggling"] as ToolMode[]) {
      for (const t of toolsFor(mode, setup(mode).env)) {
        assert.ok(t.description.length > 40, `${t.name} is described`);
        assert.strictEqual(t.parameters.type, "object");
        assert.strictEqual(t.parameters.additionalProperties, false, `${t.name} forbids unknown fields`);
        assert.match(t.name, /^[a-z_]+$/);
      }
    }
  });
});

describe("look tools", () => {
  it("get_file_outline shows the docstring and symbols, defaulting to the current file", async () => {
    const { call } = setup("chat");
    const out = await call("get_file_outline", {});
    assert.match(out, /^app\/main.py \(12 lines\)/);
    assert.match(out, /Module docstring \(L1-1\):\nWord counter\./);
    assert.match(out, /L5-7 def count\(text: str\) -> dict\[str, int\]/);
    assert.match(out, /L10-11 def top\(counts\) {2}\[stub\]/);
    assert.match(await call("get_file_outline", { path: "app/util.py" }), /def tokenize/);
    assert.match(await call("get_file_outline", { path: "nope.py" }), /^error: no file 'nope.py'/);
  });

  it("read_file numbers lines, reads the live buffer and pages long files", async () => {
    const live = APP + "\n# typed but unsaved\n";
    const { call, ws } = setup("chat", live);
    const out = await call("read_file", { start_line: 12, end_line: 13 });
    assert.match(out, /lines 12-13 of 14:\n12\| \n13\| # typed but unsaved/);
    ws.files["big.py"] = Array.from({ length: 900 }, (_, i) => `x${i} = ${i}`).join("\n");
    const big = await call("read_file", { path: "big.py" });
    assert.match(big, /lines 1-400 of 900/);
    assert.match(big, /call again with start_line=401/);
  });

  it("read_symbol returns one symbol's code by name, with hints when the name is wrong", async () => {
    const { call, ws } = setup("chat");
    assert.strictEqual(
      await call("read_symbol", { symbol: "count" }),
      "app/main.py: function count, lines 5-7:\n5| def count(text: str) -> dict[str, int]:\n6|     words = tokenize(text)\n7|     return {w: words.count(w) for w in words}",
    );
    assert.match(await call("read_symbol", { symbol: "def top(counts)" }), /function top, lines 10-11 \(stub\):\n10\| def top\(counts\):\n11\| {5}pass/);
    assert.match(await call("read_symbol", { symbol: "cuont" }), /^error: no symbol 'cuont' in app\/main.py. Did you mean 'count'\? Symbols: count, top\./);
    assert.match(await call("read_symbol", { symbol: "tokenize", path: "app/util.py" }), /function tokenize, lines 2-3/);
    ws.files["two.py"] = "class A:\n    def get(self):\n        return 1\n\nclass B:\n    def get(self):\n        return 2\n";
    assert.match(await call("read_symbol", { symbol: "get", path: "two.py" }), /^error: 'get' is ambiguous in two.py: A.get, B.get/);
    assert.match(await call("read_symbol", { symbol: "B.get", path: "two.py" }), /method B.get, lines 6-7:\n6\| {5}def get\(self\):\n7\| {9}return 2/);
    assert.match(await call("read_symbol", { symbol: "B::get", path: "two.py" }), /method B.get, lines 6-7/, "Rust-style paths work too");
    assert.match(await call("read_symbol", { symbol: "x", path: "app/.env" }), /secrets or credentials/);
  });

  it("refuses secrets and paths outside the workspace", async () => {
    const { call } = setup("chat");
    assert.match(await call("read_file", { path: "app/.env" }), /secrets or credentials/);
    assert.match(await call("read_file", { path: "../../etc/passwd" }), /outside the workspace/);
    assert.ok(!(await call("list_files", {})).includes(".env"));
  });

  it("search_code finds text and regexes with 1-based lines", async () => {
    const { call } = setup("chat");
    assert.match(await call("search_code", { query: "tokenize" }), /app\/main.py:2: from .util import tokenize/);
    assert.match(await call("search_code", { query: "def \\w+\\(text", is_regex: true, glob: "**/util.py" }), /^app\/util.py:2:/);
    assert.match(await call("search_code", { query: "(", is_regex: true }), /^error: invalid regex/);
    assert.match(await call("search_code", { query: "(\\w+)*x", is_regex: true }), /^error: the regex nests quantifiers/);
    assert.match(await call("search_code", { query: "zzz" }), /No matches/);
  });

  it("get_project_context summarizes the project around the file", async () => {
    const { call } = setup("chat");
    const out = await call("get_project_context", {});
    assert.match(out, /^Workspace files \(\d+\):/);
    assert.match(out, /README.md \(head\):\n# Demo/);
    assert.match(out, /Imported module app\/util.py — Helpers\.:\n.*def tokenize/s);
  });

  it("get_diagnostics reports 1-based lines", async () => {
    const { call } = setup("chat");
    assert.strictEqual(await call("get_diagnostics", {}), "app/main.py:10 warning (pyright): missing type annotation");
    assert.match(await call("get_diagnostics", { path: "app/util.py" }), /No diagnostics/);
  });

  it("get_recent_edits diffs against the chosen baseline", async () => {
    const live = APP.replace("pass", "return sorted(counts)");
    const { call } = setup("chat", live);
    const out = await call("get_recent_edits", {});
    assert.match(out, /^ {3}9 \| $/m);
    assert.match(out, /^- {4}\| {5}pass$/m);
    assert.match(out, /\+ 11 \| {5}return sorted\(counts\)/);
    assert.match(await setup("chat").call("get_recent_edits", { since: "graph_created" }), /No changes since the graph was created/);
  });
});

describe("graph tools", () => {
  it("add, connect, update, disconnect and remove with running totals", async () => {
    const { call, env } = setup("chat");
    const add = await call("add_nodes", {
      nodes: [
        { id: "count", kind: "function", symbol: "count", description: "Count words.", order: 1 },
        { id: "Top N", kind: "function", symbol: "top", description: "Most common words." },
        { id: "count", kind: "function", description: "Again." },
      ],
    });
    assert.match(add, /ok: added 'count'/);
    assert.match(add, /ok: added 'top_n' \(id normalized from 'Top N'\)/);
    assert.match(add, /error: node 'count' already exists; use update_nodes/);
    const bad = check({ nodes: [{ id: "w", kind: "widget", description: "x" }] }, toolsFor("chat", env).find((t) => t.name === "add_nodes")!.parameters);
    assert.match(bad.errors[0], /arguments.nodes\[0\].kind must be one of module, class, function/);
    assert.match(add, /Graph now has 2 nodes and 0 edges\./);
    assert.match(await call("connect", { edges: [{ from: "top_n", to: "count", kind: "calls" }] }), /ok: top_n -calls-> count/);
    assert.match(await call("connect", { edges: [{ from: "top_m", to: "count", kind: "calls" }] }), /unknown node id 'top_m'. Did you mean 'top_n'\?/);
    assert.match(await call("update_nodes", { updates: [{ id: "count", set: { attention: "Off by one" } }] }), /updated 'count' \(attention\)/);
    assert.strictEqual(env.editor.graph.nodes[0].status, "attention");
    assert.match(await call("disconnect", { edges: [{ from: "top_n", to: "count" }] }), /removed 1 edge/);
    assert.match(await call("remove_nodes", { ids: ["top_n"], reason: "merged" }), /ok: removed 'top_n'/);
    assert.match(await call("get_graph", {}), /nodes \(1\):\n- count \[function, attention, order 1\] symbol=count/);
  });
});

describe("get_graph for another file", () => {
  it("reads another planned file's graph read-only, and says when there is none", async () => {
    const { call, env } = setup("chat");
    env.graphOf = (rel) =>
      rel === "app/util.py"
        ? {
            file: "app/util.py",
            language: "python",
            moduleString: "Helpers.",
            nodes: [{ id: "tokenize", kind: "function", label: "tokenize", symbol: "tokenize", description: "Split text.", notes: [], status: "done", line: 1 }],
            edges: [],
            revision: 4,
            updatedAt: "",
          }
        : undefined;
    assert.match(await call("get_graph", { path: "app/util.py" }), /^Graph for app\/util.py \(revision 4\) \(read-only\):\nnodes \(1\):\n- tokenize \[function, done, L2\]/);
    assert.strictEqual(await call("get_graph", { path: "README.md" }), "README.md has no implementation graph yet.");
    assert.match(await call("get_graph", { path: "../x.py" }), /outside the workspace/);
    assert.strictEqual(await call("get_graph", {}), "app/main.py has no implementation graph yet.");
  });
});

describe("talk tools", () => {
  it("recommend_resources shows checked links and reports dropped ones", async () => {
    const { call, emitted } = setup("chat");
    const out = await call("recommend_resources", {
      topic: "Counter",
      resources: [
        { title: "Counter docs", url: "https://docs.python.org/3/library/collections.html#collections.Counter", type: "docs", why: "API" },
        { title: "Gone", url: "https://example.com/missing", type: "article", why: "x" },
      ],
    });
    assert.match(out, /ok: showed 1 resource\(s\) on 'Counter'. Dropped: https:\/\/example.com\/missing \(HTTP 404\)/);
    assert.strictEqual(emitted[0].kind, "resources");
    const all = await call("recommend_resources", { topic: "x", resources: [{ title: "Gone", url: "https://e.com/missing", type: "docs", why: "x" }] });
    assert.match(all, /^error: none of the links could be used/);
  });

  it("recommend_resources does not repeat links that are already in the panel", async () => {
    const counter = "https://docs.python.org/3/library/collections.html#collections.Counter";
    const feed: FeedItem[] = [
      { id: "r1", ts: "", kind: "resources", topic: "Counter", items: [{ title: "Counter", url: counter, type: "docs", why: "API", verified: "ok" }] },
    ];
    const { call, emitted } = setup("chat", APP, feed);
    const same = await call("recommend_resources", { topic: "Counter", resources: [{ title: "Counter", url: counter, type: "docs", why: "API" }] });
    assert.match(same, /already has these links in the panel; nothing new was shown/);
    assert.strictEqual(emitted.length, 0);
    const mixed = await call("recommend_resources", {
      topic: "Counting",
      resources: [
        { title: "Counter", url: counter, type: "docs", why: "API" },
        { title: "HOWTO", url: "https://docs.python.org/3/howto/sorting.html", type: "tutorial", why: "Sorting" },
      ],
    });
    assert.match(mixed, /ok: showed 1 resource\(s\) on 'Counting'\. Already in the panel \(not shown again\): https:\/\/docs.python.org/);
    assert.deepStrictEqual((emitted[0] as Extract<NewFeedItem, { kind: "resources" }>).items.map((r) => r.title), ["HOWTO"]);
  });

  it("ask_programmer and point_to_code emit feed items with 0-based lines", async () => {
    const { call, emitted } = setup("chat");
    await call("ask_programmer", { question: "Case-sensitive?", options: ["yes", "no", " "] });
    await call("point_to_code", { line: 6, end_line: 7, note: "Use a Counter here." });
    assert.deepStrictEqual(emitted[0], { kind: "question", question: "Case-sensitive?", options: ["yes", "no"] });
    assert.deepStrictEqual(emitted[1], { kind: "code_ref", path: "app/main.py", line: 5, endLine: 6, note: "Use a Counter here." });
  });

  it("interrupt_programmer emits once, records the line text, and ends the heartbeat", async () => {
    const { call, emitted, ctx } = setup("heartbeat");
    const args = { title: "Quadratic count", message: "`words.count` in a loop is O(n²); use a Counter.", line: 7, issue: "better_implementation", severity: 2 };
    assert.strictEqual(await call("interrupt_programmer", args), "ok: the programmer was interrupted.");
    assert.match(await call("interrupt_programmer", args), /already interrupted/);
    assert.strictEqual(emitted.length, 1);
    const item = emitted[0] as Extract<NewFeedItem, { kind: "interrupt" }>;
    assert.strictEqual(item.line, 6);
    assert.strictEqual(item.lineText, "    return {w: words.count(w) for w in words}");
    assert.strictEqual(item.status, "open");
    assert.strictEqual(ctx.stop?.reason, "interrupted: Quadratic count");
    assert.match(await setup("heartbeat").call("interrupt_programmer", { ...args, line: 99 }), /past the end of the file/);
  });

  it("interrupt_programmer refuses to repeat a problem that is already reported on the same line", async () => {
    const feed: FeedItem[] = [
      {
        id: "i1",
        ts: "",
        kind: "interrupt",
        title: "Quadratic count",
        message: "m",
        line: 6,
        issue: "better_implementation",
        severity: 2,
        status: "dismissed",
        lineText: "    return {w: words.count(w) for w in words}",
      },
    ];
    const { call, emitted, ctx } = setup("heartbeat", APP, feed);
    const args = { title: "Still quadratic", message: "Use a Counter.", line: 7, issue: "better_implementation", severity: 2 };
    assert.match(await call("interrupt_programmer", args), /^error: this better implementation on line 7 was already reported .* stand_down, or report a different problem/);
    assert.strictEqual(emitted.length, 0);
    assert.strictEqual(ctx.stop, undefined, "the turn continues so the model can stand down");
    // A different problem is still allowed in the same heartbeat.
    assert.strictEqual(await call("interrupt_programmer", { ...args, issue: "logic_error" }), "ok: the programmer was interrupted.");
  });

  it("stand_down ends the heartbeat", async () => {
    const { call, ctx } = setup("heartbeat");
    await call("stand_down", { reason: "still typing" });
    assert.strictEqual(ctx.stop?.reason, "still typing");
  });
});
