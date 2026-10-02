import * as assert from "node:assert";
import type { FileOutline, OutlineSymbol } from "../../src/code/outline";
import {
  cloneGraph,
  compactGraph,
  describeSummary,
  emptyGraph,
  emptySummary,
  findSymbol,
  graphForJev,
  GraphEditor,
  MAX_EDGES,
  MAX_NODES,
  slugify,
  syncWithOutline,
  toMermaid,
  unplannedSymbols,
} from "../../src/graph/model";
import { orderedNodes } from "../../src/graph/order";
import { EDGE_KINDS, type FileGraph, type GraphEdge, type GraphNode, NODE_KINDS } from "../../src/types";

// ---------------------------------------------------------------- factories

const OLD_STAMP = "2000-01-01T00:00:00.000Z";

function node(over: Partial<GraphNode> & { id: string }): GraphNode {
  return { kind: "function", label: over.id, description: `does ${over.id}`, notes: [], status: "planned", ...over };
}

function edge(from: string, to: string, kind: GraphEdge["kind"] = "calls", label?: string): GraphEdge {
  return label === undefined ? { from, to, kind } : { from, to, kind, label };
}

function graph(nodes: GraphNode[] = [], edges: GraphEdge[] = [], revision = 3): FileGraph {
  return { file: "app/main.py", language: "python", moduleString: "Fetch and cache.", nodes, edges, revision, updatedAt: OLD_STAMP };
}

function manyNodes(n: number): GraphNode[] {
  return Array.from({ length: n }, (_, i) => node({ id: `n${i}` }));
}

function sym(qualname: string, over: Partial<OutlineSymbol> = {}): OutlineSymbol {
  const name = qualname.split(".").pop()!;
  return {
    name,
    qualname,
    kind: "function",
    line: 0,
    endLine: 1,
    signature: `def ${name}()`,
    isStub: false,
    ...over,
  };
}

function outlineOf(...symbols: OutlineSymbol[]): FileOutline {
  return { language: "python", symbols, imports: [], parser: "tree-sitter", hasErrors: false };
}

const ids = (g: FileGraph) => g.nodes.map((n) => n.id);

// ---------------------------------------------------------------- slugify

describe("slugify", () => {
  it("snake-cases camelCase and PascalCase", () => {
    assert.strictEqual(slugify("fetchIssues"), "fetch_issues");
    assert.strictEqual(slugify("FetchIssues"), "fetch_issues");
    assert.strictEqual(slugify("fetch2Issues"), "fetch2_issues");
  });

  it("turns dots and other punctuation into single underscores", () => {
    assert.strictEqual(slugify("Cache.get"), "cache_get");
    assert.strictEqual(slugify("a.b.c"), "a_b_c");
    assert.strictEqual(slugify("a--b__c  d"), "a_b_c_d");
    assert.strictEqual(slugify("get(url, retries=3)"), "get_url_retries_3");
  });

  it("strips leading and trailing separators", () => {
    assert.strictEqual(slugify("__init__"), "init");
    assert.strictEqual(slugify("  Hello, World!  "), "hello_world");
  });

  it("leaves a valid slug alone", () => {
    assert.strictEqual(slugify("cache_get"), "cache_get");
    assert.strictEqual(slugify("step_2"), "step_2");
  });

  it("returns an empty string when nothing usable is left", () => {
    assert.strictEqual(slugify(""), "");
    assert.strictEqual(slugify("!!! ..."), "");
  });

  it("caps the length at 48 characters", () => {
    assert.strictEqual(slugify("a".repeat(60)).length, 48);
    assert.strictEqual(slugify("a".repeat(48)), "a".repeat(48));
    assert.strictEqual(slugify("a".repeat(49)), "a".repeat(48));
    assert.strictEqual(slugify("someVeryLongFunctionName".repeat(5)).length, 48);
  });
});

describe("emptyGraph / cloneGraph", () => {
  it("emptyGraph starts at revision 0 with no nodes or edges", () => {
    const g = emptyGraph("a/b.py", "python", "Doc.");
    assert.strictEqual(g.file, "a/b.py");
    assert.strictEqual(g.language, "python");
    assert.strictEqual(g.moduleString, "Doc.");
    assert.deepStrictEqual(g.nodes, []);
    assert.deepStrictEqual(g.edges, []);
    assert.strictEqual(g.revision, 0);
    assert.ok(!Number.isNaN(Date.parse(g.updatedAt)));
  });

  it("cloneGraph is a deep copy", () => {
    const g = graph([node({ id: "a", notes: ["n"] })], [edge("a", "a2")]);
    const c = cloneGraph(g);
    assert.deepStrictEqual(c, g);
    c.nodes[0].notes.push("changed");
    c.edges[0].kind = "uses";
    assert.deepStrictEqual(g.nodes[0].notes, ["n"]);
    assert.strictEqual(g.edges[0].kind, "calls");
  });
});

// ---------------------------------------------------------------- addNodes

describe("GraphEditor.addNodes", () => {
  it("adds a node and reports an ok line", () => {
    const ed = new GraphEditor(graph());
    const out = ed.addNodes([{ id: "fetch", kind: "function", description: "Fetch the issues." }]);
    assert.deepStrictEqual(out, ["ok: added 'fetch'."]);
    assert.deepStrictEqual(ids(ed.graph), ["fetch"]);
    const n = ed.graph.nodes[0];
    assert.strictEqual(n.kind, "function");
    assert.strictEqual(n.status, "planned");
    assert.strictEqual(n.label, "fetch");
    assert.strictEqual(n.description, "Fetch the issues.");
    assert.deepStrictEqual(n.notes, []);
    assert.strictEqual(n.symbol, undefined);
    assert.strictEqual(n.order, undefined);
  });

  it("does not modify the graph it was constructed from", () => {
    const original = graph([node({ id: "a" })]);
    const ed = new GraphEditor(original);
    ed.addNodes([{ id: "b", kind: "class", description: "B." }]);
    assert.deepStrictEqual(ids(original), ["a"]);
    assert.deepStrictEqual(ids(ed.graph), ["a", "b"]);
  });

  it("normalizes ids and says so", () => {
    const ed = new GraphEditor(graph());
    const out = ed.addNodes([{ id: "Cache.get", kind: "method", description: "Look up a key." }]);
    assert.deepStrictEqual(out, ["ok: added 'cache_get' (id normalized from 'Cache.get')."]);
    assert.deepStrictEqual(ids(ed.graph), ["cache_get"]);
  });

  it("falls back to the symbol, then the label, when the id is empty", () => {
    const ed = new GraphEditor(graph());
    const out = ed.addNodes([
      { id: "", kind: "method", symbol: "Cache.get", description: "x" },
      { id: "", kind: "step", label: "Parse the response", description: "y" },
    ]);
    assert.deepStrictEqual(out, [
      "ok: added 'cache_get' (id normalized from '').",
      "ok: added 'parse_the_response' (id normalized from '').",
    ]);
  });

  it("rejects a node with no usable id", () => {
    const ed = new GraphEditor(graph());
    assert.deepStrictEqual(ed.addNodes([{ id: "", kind: "function", description: "x" }]), ["error: a node needs an id (snake_case slug)."]);
    assert.deepStrictEqual(ed.addNodes([{ id: "!!!", kind: "function", description: "x" }]), ["error: a node needs an id (snake_case slug)."]);
    assert.strictEqual(ed.changed, false);
  });

  it("rejects a duplicate id, also after normalization and within one batch", () => {
    const ed = new GraphEditor(graph([node({ id: "cache_get" })]));
    const out = ed.addNodes([
      { id: "cache_get", kind: "method", description: "x" },
      { id: "Cache.get", kind: "method", description: "x" },
      { id: "fresh", kind: "function", description: "x" },
      { id: "fresh", kind: "function", description: "again" },
    ]);
    assert.deepStrictEqual(out, [
      "error: node 'cache_get' already exists; use update_nodes to change it.",
      "error: node 'cache_get' already exists; use update_nodes to change it.",
      "ok: added 'fresh'.",
      "error: node 'fresh' already exists; use update_nodes to change it.",
    ]);
    assert.deepStrictEqual(ed.summary().added, ["fresh"]);
  });

  it("rejects an invalid kind and lists the valid ones", () => {
    const ed = new GraphEditor(graph());
    const [line] = ed.addNodes([{ id: "x", kind: "widget", description: "d" }]);
    assert.strictEqual(line, `error: node 'x': kind 'widget' is not one of ${NODE_KINDS.join(", ")}.`);
    assert.ok(line.includes("module, class, function, method, data, constant, test, external, step"));
    assert.deepStrictEqual(ed.graph.nodes, []);
  });

  it("accepts every node kind", () => {
    const ed = new GraphEditor(graph());
    const out = ed.addNodes(NODE_KINDS.map((k) => ({ id: `n_${k}`, kind: k, description: "d" })));
    assert.ok(out.every((l) => l.startsWith("ok:")), out.join("\n"));
  });

  it("requires a non-blank description", () => {
    const ed = new GraphEditor(graph());
    const out = ed.addNodes([
      { id: "a", kind: "function", description: "" },
      { id: "b", kind: "function", description: "   \n" },
      { id: "c", kind: "function" } as unknown as { id: string; kind: string; description: string },
    ]);
    assert.deepStrictEqual(out, [
      "error: node 'a' needs a description.",
      "error: node 'b' needs a description.",
      "error: node 'c' needs a description.",
    ]);
    assert.strictEqual(ed.changed, false);
  });

  it("checks the kind before the description", () => {
    const ed = new GraphEditor(graph());
    const [line] = ed.addNodes([{ id: "a", kind: "nope", description: "" }]);
    assert.match(line, /kind 'nope' is not one of/);
  });

  it("stops at MAX_NODES with an error naming the cap", () => {
    const ed = new GraphEditor(graph(manyNodes(MAX_NODES - 1)));
    const out = ed.addNodes([
      { id: "last_one", kind: "function", description: "fits" },
      { id: "one_too_many", kind: "function", description: "does not fit" },
    ]);
    assert.strictEqual(out[0], "ok: added 'last_one'.");
    assert.strictEqual(out[1], `error: the graph already has ${MAX_NODES} nodes; merge or remove some first.`);
    assert.strictEqual(ed.graph.nodes.length, MAX_NODES);
    assert.ok(!ids(ed.graph).includes("one_too_many"));
  });

  it("a full graph accepts nothing more", () => {
    const ed = new GraphEditor(graph(manyNodes(MAX_NODES)));
    const out = ed.addNodes([{ id: "extra", kind: "function", description: "x" }]);
    assert.match(out[0], /^error: the graph already has 60 nodes/);
    assert.strictEqual(ed.changed, false);
  });

  it("defaults the label to the symbol, then the id, and clips it to 60 characters", () => {
    const ed = new GraphEditor(graph());
    ed.addNodes([
      { id: "a", kind: "method", symbol: "Cache.get", description: "d" },
      { id: "b", kind: "function", description: "d" },
      { id: "c", kind: "function", label: "L".repeat(100), description: "d" },
    ]);
    const [a, b, c] = ed.graph.nodes;
    assert.strictEqual(a.label, "Cache.get");
    assert.strictEqual(b.label, "b");
    assert.strictEqual(c.label.length, 60);
    assert.ok(c.label.endsWith("…"));
  });

  it("trims symbol and signature, dropping blank ones", () => {
    const ed = new GraphEditor(graph());
    ed.addNodes([
      { id: "a", kind: "function", symbol: "  fetch  ", signature: "  def fetch(repo)  ", description: "d" },
      { id: "b", kind: "function", symbol: "   ", signature: "   ", description: "d" },
    ]);
    assert.strictEqual(ed.graph.nodes[0].symbol, "fetch");
    assert.strictEqual(ed.graph.nodes[0].signature, "def fetch(repo)");
    assert.strictEqual(ed.graph.nodes[1].symbol, undefined);
    assert.strictEqual(ed.graph.nodes[1].signature, undefined);
  });

  it("clips long descriptions and signatures", () => {
    const ed = new GraphEditor(graph());
    ed.addNodes([{ id: "a", kind: "function", description: "d".repeat(700), signature: "s".repeat(500) }]);
    const n = ed.graph.nodes[0];
    assert.strictEqual(n.description.length, 600);
    assert.ok(n.description.endsWith("…"));
    assert.strictEqual(n.signature!.length, 400);
  });

  it("trims the description", () => {
    const ed = new GraphEditor(graph());
    ed.addNodes([{ id: "a", kind: "function", description: "  padded \n" }]);
    assert.strictEqual(ed.graph.nodes[0].description, "padded");
  });

  it("cleans notes: drops blanks and non-strings, clips to 300, keeps at most 8", () => {
    const ed = new GraphEditor(graph());
    ed.addNodes([
      {
        id: "a",
        kind: "function",
        description: "d",
        notes: ["  keep me  ", "", "   ", 42 as unknown as string, "x".repeat(400), ...Array.from({ length: 12 }, (_, i) => `note ${i}`)],
      },
    ]);
    const notes = ed.graph.nodes[0].notes;
    assert.strictEqual(notes.length, 8);
    assert.strictEqual(notes[0], "keep me");
    assert.strictEqual(notes[1].length, 300);
    assert.ok(notes[1].endsWith("…"));
    assert.strictEqual(notes[2], "note 0");
  });

  it("treats non-array notes as empty", () => {
    const ed = new GraphEditor(graph());
    ed.addNodes([{ id: "a", kind: "function", description: "d", notes: "just a string" as unknown as string[] }]);
    assert.deepStrictEqual(ed.graph.nodes[0].notes, []);
  });

  it("keeps only positive orders, rounded", () => {
    const ed = new GraphEditor(graph());
    ed.addNodes([
      { id: "a", kind: "function", description: "d", order: 2.6 },
      { id: "b", kind: "function", description: "d", order: -1 },
      { id: "c", kind: "function", description: "d", order: "3" as unknown as number },
      { id: "d", kind: "function", description: "d" },
    ]);
    assert.deepStrictEqual(
      ed.graph.nodes.map((n) => n.order),
      [3, undefined, undefined, undefined],
    );
  });

  it("records added nodes in the summary", () => {
    const ed = new GraphEditor(graph());
    ed.addNodes([
      { id: "a", kind: "function", description: "d" },
      { id: "b", kind: "class", description: "d" },
    ]);
    assert.deepStrictEqual(ed.summary(), { added: ["a", "b"], updated: [], removed: [], edgesAdded: 0, edgesRemoved: 0 });
    assert.strictEqual(ed.changed, true);
  });
});

// ---------------------------------------------------------------- updateNodes

describe("GraphEditor.updateNodes", () => {
  const base = () =>
    graph([
      node({ id: "cache_get", kind: "method", label: "Cache.get", symbol: "Cache.get", description: "Look up.", notes: ["n1", "n2"], order: 2 }),
      node({ id: "fetch", description: "Fetch." }),
    ]);

  it("sets individual fields and lists them in the ok line", () => {
    const ed = new GraphEditor(base());
    const out = ed.updateNodes([
      {
        id: "fetch",
        set: { label: "Fetch!", description: "Fetch everything.", signature: "def fetch(repo)", symbol: "fetch", order: 4, kind: "method" },
      },
    ]);
    assert.deepStrictEqual(out, ["ok: updated 'fetch' (kind, label, symbol, signature, description, order)."]);
    const n = ed.graph.nodes[1];
    assert.strictEqual(n.kind, "method");
    assert.strictEqual(n.label, "Fetch!");
    assert.strictEqual(n.symbol, "fetch");
    assert.strictEqual(n.signature, "def fetch(repo)");
    assert.strictEqual(n.description, "Fetch everything.");
    assert.strictEqual(n.order, 4);
  });

  it("clears symbol, signature and order with empty/zero values and resets a blank label to the id", () => {
    const g = base();
    g.nodes[0].signature = "def get()";
    const ed = new GraphEditor(g);
    ed.updateNodes([{ id: "cache_get", set: { symbol: "  ", signature: "", order: 0, label: "  " } }]);
    const n = ed.graph.nodes[0];
    assert.strictEqual(n.symbol, undefined);
    assert.strictEqual(n.signature, undefined);
    assert.strictEqual(n.order, undefined);
    assert.strictEqual(n.label, "cache_get");
  });

  it("ignores a blank description rather than clearing it", () => {
    const ed = new GraphEditor(base());
    const out = ed.updateNodes([{ id: "fetch", set: { description: "   " } }]);
    assert.strictEqual(ed.graph.nodes[1].description, "Fetch.");
    assert.match(out[0], /nothing to update/);
  });

  it("set.notes replaces the notes", () => {
    const ed = new GraphEditor(base());
    const out = ed.updateNodes([{ id: "cache_get", set: { notes: ["only this"] } }]);
    assert.deepStrictEqual(out, ["ok: updated 'cache_get' (notes)."]);
    assert.deepStrictEqual(ed.graph.nodes[0].notes, ["only this"]);
  });

  it("set.notes with an empty list clears the notes", () => {
    const ed = new GraphEditor(base());
    ed.updateNodes([{ id: "cache_get", set: { notes: [] } }]);
    assert.deepStrictEqual(ed.graph.nodes[0].notes, []);
  });

  it("append_notes appends to the existing notes", () => {
    const ed = new GraphEditor(base());
    const out = ed.updateNodes([{ id: "cache_get", append_notes: ["n3", " ", "n4"] }]);
    assert.deepStrictEqual(out, ["ok: updated 'cache_get' (notes+)."]);
    assert.deepStrictEqual(ed.graph.nodes[0].notes, ["n1", "n2", "n3", "n4"]);
  });

  it("append_notes keeps only the most recent 8 notes", () => {
    const g = base();
    g.nodes[0].notes = ["a", "b", "c", "d", "e", "f", "g"];
    const ed = new GraphEditor(g);
    ed.updateNodes([{ id: "cache_get", append_notes: ["h", "i", "j"] }]);
    assert.deepStrictEqual(ed.graph.nodes[0].notes, ["c", "d", "e", "f", "g", "h", "i", "j"]);
  });

  it("set.notes and append_notes together replace first, then append", () => {
    const ed = new GraphEditor(base());
    const out = ed.updateNodes([{ id: "cache_get", set: { notes: ["fresh"] }, append_notes: ["more"] }]);
    assert.deepStrictEqual(out, ["ok: updated 'cache_get' (notes, notes+)."]);
    assert.deepStrictEqual(ed.graph.nodes[0].notes, ["fresh", "more"]);
  });

  it("an empty append_notes list is nothing to update", () => {
    const ed = new GraphEditor(base());
    const out = ed.updateNodes([{ id: "cache_get", append_notes: [] }]);
    assert.strictEqual(out[0], "error: node 'cache_get': nothing to update (give 'set' fields or 'append_notes').");
  });

  it("reports nothing to update for an empty request", () => {
    const ed = new GraphEditor(base());
    const out = ed.updateNodes([{ id: "fetch" }, { id: "fetch", set: {} }]);
    assert.deepStrictEqual(out, [
      "error: node 'fetch': nothing to update (give 'set' fields or 'append_notes').",
      "error: node 'fetch': nothing to update (give 'set' fields or 'append_notes').",
    ]);
    assert.strictEqual(ed.changed, false);
  });

  it("finds a node by an id that needs normalizing", () => {
    const ed = new GraphEditor(base());
    const out = ed.updateNodes([{ id: "Cache.get", set: { label: "renamed" } }]);
    assert.deepStrictEqual(out, ["ok: updated 'cache_get' (label)."]);
    assert.strictEqual(ed.graph.nodes[0].label, "renamed");
  });

  it("rejects an invalid kind with the list of kinds", () => {
    const ed = new GraphEditor(base());
    const [line] = ed.updateNodes([{ id: "fetch", set: { kind: "gadget" } }]);
    assert.strictEqual(line, `error: node 'fetch': kind 'gadget' is not one of ${NODE_KINDS.join(", ")}.`);
    assert.strictEqual(ed.graph.nodes[1].kind, "function");
    assert.strictEqual(ed.changed, false);
  });

  it("rejects an invalid status and lists the valid ones", () => {
    const ed = new GraphEditor(base());
    const [line] = ed.updateNodes([{ id: "fetch", set: { status: "finished" } }]);
    assert.strictEqual(line, "error: node 'fetch': status must be one of planned, stubbed, done, attention.");
    assert.strictEqual(ed.graph.nodes[1].status, "planned");
    assert.strictEqual(ed.changed, false);
  });

  it("sets a valid status", () => {
    const ed = new GraphEditor(base());
    const out = ed.updateNodes([{ id: "fetch", set: { status: "stubbed" } }]);
    assert.deepStrictEqual(out, ["ok: updated 'fetch' (status)."]);
    assert.strictEqual(ed.graph.nodes[1].status, "stubbed");
  });

  it("an update that fails validation changes nothing (no partial application)", () => {
    const ed = new GraphEditor(base());
    const [line] = ed.updateNodes([{ id: "fetch", set: { kind: "class", status: "bogus" } }]);
    assert.match(line, /^error:/);
    assert.strictEqual(ed.graph.nodes[1].kind, "function");
  });

  it("attention sets the text and forces status 'attention'", () => {
    const ed = new GraphEditor(base());
    const out = ed.updateNodes([{ id: "fetch", set: { attention: "  off by one in the loop  " } }]);
    assert.deepStrictEqual(out, ["ok: updated 'fetch' (attention)."]);
    assert.strictEqual(ed.graph.nodes[1].attention, "off by one in the loop");
    assert.strictEqual(ed.graph.nodes[1].status, "attention");
  });

  it("clips the attention text to 300 characters", () => {
    const ed = new GraphEditor(base());
    ed.updateNodes([{ id: "fetch", set: { attention: "z".repeat(500) } }]);
    assert.strictEqual(ed.graph.nodes[1].attention!.length, 300);
  });

  it("clearing attention restores 'planned' when the node has no line", () => {
    const g = base();
    g.nodes[1].status = "attention";
    g.nodes[1].attention = "problem";
    const ed = new GraphEditor(g);
    ed.updateNodes([{ id: "fetch", set: { attention: "" } }]);
    assert.strictEqual(ed.graph.nodes[1].attention, undefined);
    assert.strictEqual(ed.graph.nodes[1].status, "planned");
  });

  it("clearing attention restores 'done' when the node has a line (including line 0)", () => {
    for (const line of [0, 7]) {
      const g = base();
      Object.assign(g.nodes[1], { status: "attention", attention: "problem", line });
      const ed = new GraphEditor(g);
      ed.updateNodes([{ id: "fetch", set: { attention: "   " } }]);
      assert.strictEqual(ed.graph.nodes[1].attention, undefined, `line ${line}`);
      assert.strictEqual(ed.graph.nodes[1].status, "done", `line ${line}`);
    }
  });

  it("clearing attention leaves other statuses alone", () => {
    const g = base();
    g.nodes[1].status = "stubbed";
    const ed = new GraphEditor(g);
    const out = ed.updateNodes([{ id: "fetch", set: { attention: "" } }]);
    assert.strictEqual(ed.graph.nodes[1].status, "stubbed");
    assert.deepStrictEqual(out, ["ok: updated 'fetch' (attention)."]);
  });

  describe("unknown ids", () => {
    it("suggests a near-miss id", () => {
      const ed = new GraphEditor(base());
      const [line] = ed.updateNodes([{ id: "cahce_get", set: { label: "x" } }]);
      assert.ok(line.startsWith("error: unknown node id 'cahce_get'."), line);
      assert.ok(line.includes("Did you mean 'cache_get'?"), line);
      assert.ok(line.includes("Existing ids: cache_get, fetch."), line);
    });

    it("omits the hint when nothing is close", () => {
      const ed = new GraphEditor(base());
      const [line] = ed.updateNodes([{ id: "completely_different", set: { label: "x" } }]);
      assert.ok(!line.includes("Did you mean"), line);
      assert.ok(line.includes("Existing ids: cache_get, fetch."), line);
    });

    it("says so when the graph has no nodes", () => {
      const ed = new GraphEditor(graph());
      const [line] = ed.updateNodes([{ id: "x", set: { label: "y" } }]);
      assert.strictEqual(line, "error: unknown node id 'x'. The graph has no nodes yet.");
    });

    it("picks the closest of several candidates", () => {
      const ed = new GraphEditor(graph([node({ id: "parse_a" }), node({ id: "parse_response" }), node({ id: "parse_resp" })]));
      assert.match(ed.unknownId("parse_respnse"), /Did you mean 'parse_response'\?/);
    });

    it("unknownId is usable directly", () => {
      const ed = new GraphEditor(base());
      assert.strictEqual(ed.unknownId("fetsh"), "unknown node id 'fetsh'. Did you mean 'fetch'? Existing ids: cache_get, fetch.");
    });
  });

  it("tracks updates in the summary once per node", () => {
    const ed = new GraphEditor(base());
    ed.updateNodes([{ id: "fetch", set: { label: "a" } }]);
    ed.updateNodes([{ id: "fetch", set: { label: "b" } }, { id: "cache_get", set: { label: "c" } }]);
    assert.deepStrictEqual(ed.summary().updated, ["fetch", "cache_get"]);
    assert.strictEqual(ed.changed, true);
  });

  it("does not list a node as updated when it was added by the same editor", () => {
    const ed = new GraphEditor(graph());
    ed.addNodes([{ id: "new_one", kind: "function", description: "d" }]);
    ed.updateNodes([{ id: "new_one", set: { description: "better" } }]);
    assert.deepStrictEqual(ed.summary().added, ["new_one"]);
    assert.deepStrictEqual(ed.summary().updated, []);
  });

  it("continues with later updates after an error", () => {
    const ed = new GraphEditor(base());
    const out = ed.updateNodes([{ id: "ghost", set: { label: "x" } }, { id: "fetch", set: { label: "y" } }]);
    assert.ok(out[0].startsWith("error:"));
    assert.strictEqual(out[1], "ok: updated 'fetch' (label).");
  });
});

// ---------------------------------------------------------------- removeNodes

describe("GraphEditor.removeNodes", () => {
  const base = () =>
    graph(
      [node({ id: "a" }), node({ id: "b" }), node({ id: "c" })],
      [edge("a", "b"), edge("b", "c"), edge("c", "a", "uses"), edge("a", "c", "depends")],
    );

  it("removes the node and every incident edge, and reports how many", () => {
    const ed = new GraphEditor(base());
    const out = ed.removeNodes(["b"]);
    assert.deepStrictEqual(out, ["ok: removed 'b' and 2 edge(s)."]);
    assert.deepStrictEqual(ids(ed.graph), ["a", "c"]);
    assert.deepStrictEqual(ed.graph.edges, [edge("c", "a", "uses"), edge("a", "c", "depends")]);
    assert.deepStrictEqual(ed.summary(), { added: [], updated: [], removed: ["b"], edgesAdded: 0, edgesRemoved: 2 });
  });

  it("counts edges in both directions", () => {
    const ed = new GraphEditor(base());
    const out = ed.removeNodes(["a"]);
    assert.deepStrictEqual(out, ["ok: removed 'a' and 3 edge(s)."]);
    assert.strictEqual(ed.summary().edgesRemoved, 3);
  });

  it("omits the edge count for an isolated node", () => {
    const ed = new GraphEditor(graph([node({ id: "lonely" })]));
    assert.deepStrictEqual(ed.removeNodes(["lonely"]), ["ok: removed 'lonely'."]);
  });

  it("finds a node by a non-normalized id", () => {
    const ed = new GraphEditor(graph([node({ id: "cache_get" })]));
    assert.deepStrictEqual(ed.removeNodes(["Cache.get"]), ["ok: removed 'cache_get'."]);
  });

  it("reports an unknown id with a suggestion", () => {
    const ed = new GraphEditor(base());
    const [line] = ed.removeNodes(["bb"]);
    assert.ok(line.startsWith("error: unknown node id 'bb'."), line);
    assert.ok(line.includes("Did you mean"), line);
    assert.strictEqual(ed.changed, false);
  });

  it("removing the same id twice errors the second time", () => {
    const ed = new GraphEditor(base());
    const out = ed.removeNodes(["a", "a"]);
    assert.ok(out[0].startsWith("ok: removed 'a'"));
    assert.ok(out[1].startsWith("error: unknown node id 'a'."));
    assert.deepStrictEqual(ed.summary().removed, ["a"]);
  });

  it("a node added and removed in one editor leaves no trace in the summary", () => {
    const ed = new GraphEditor(graph([node({ id: "keep" })]));
    ed.addNodes([{ id: "temp", kind: "function", description: "d" }]);
    ed.removeNodes(["temp"]);
    assert.deepStrictEqual(ed.summary(), emptySummary());
    assert.strictEqual(ed.changed, false);
    assert.strictEqual(ed.result().revision, 3);
    assert.deepStrictEqual(ids(ed.graph), ["keep"]);
  });

  it("removing a node that was updated moves it from updated to removed", () => {
    const ed = new GraphEditor(base());
    ed.updateNodes([{ id: "b", set: { label: "B" } }]);
    assert.deepStrictEqual(ed.summary().updated, ["b"]);
    ed.removeNodes(["b"]);
    assert.deepStrictEqual(ed.summary().updated, []);
    assert.deepStrictEqual(ed.summary().removed, ["b"]);
  });
});

// ---------------------------------------------------------------- connect

describe("GraphEditor.connect", () => {
  const base = () => graph([node({ id: "a" }), node({ id: "b" }), node({ id: "cache_get" })]);

  it("adds an edge", () => {
    const ed = new GraphEditor(base());
    assert.deepStrictEqual(ed.connect([{ from: "a", to: "b", kind: "calls" }]), ["ok: a -calls-> b."]);
    assert.deepStrictEqual(ed.graph.edges, [{ from: "a", to: "b", kind: "calls" }]);
    assert.strictEqual(ed.summary().edgesAdded, 1);
  });

  it("stores a trimmed, clipped label", () => {
    const ed = new GraphEditor(base());
    ed.connect([
      { from: "a", to: "b", kind: "calls", label: "  retries  " },
      { from: "b", to: "a", kind: "uses", label: "L".repeat(100) },
      { from: "a", to: "cache_get", kind: "uses", label: "   " },
    ]);
    assert.strictEqual(ed.graph.edges[0].label, "retries");
    assert.strictEqual(ed.graph.edges[1].label!.length, 60);
    assert.ok(!("label" in ed.graph.edges[2]));
  });

  it("resolves endpoints that need normalizing", () => {
    const ed = new GraphEditor(base());
    const out = ed.connect([{ from: "A", to: "Cache.get", kind: "calls" }]);
    assert.deepStrictEqual(out, ["ok: a -calls-> cache_get."]);
    assert.deepStrictEqual(ed.graph.edges, [{ from: "a", to: "cache_get", kind: "calls" }]);
  });

  it("names the unknown source id", () => {
    const ed = new GraphEditor(base());
    const [line] = ed.connect([{ from: "zz_missing", to: "b", kind: "calls" }]);
    assert.ok(line.startsWith("error: unknown node id 'zz_missing'."), line);
    assert.ok(line.includes("Existing ids: a, b, cache_get."), line);
  });

  it("names the unknown target id", () => {
    const ed = new GraphEditor(base());
    const [line] = ed.connect([{ from: "a", to: "cache_gte", kind: "calls" }]);
    assert.ok(line.startsWith("error: unknown node id 'cache_gte'."), line);
    assert.ok(line.includes("Did you mean 'cache_get'?"), line);
  });

  it("names the source first when both ids are unknown", () => {
    const ed = new GraphEditor(base());
    const [line] = ed.connect([{ from: "nope1", to: "nope2", kind: "calls" }]);
    assert.ok(line.startsWith("error: unknown node id 'nope1'."), line);
  });

  it("rejects an invalid kind and lists the valid ones", () => {
    const ed = new GraphEditor(base());
    const [line] = ed.connect([{ from: "a", to: "b", kind: "likes" }]);
    assert.strictEqual(line, `error: edge a→b: kind 'likes' is not one of ${EDGE_KINDS.join(", ")}.`);
    assert.ok(line.includes("calls, uses, contains, creates, reads, writes, returns, depends"));
    assert.deepStrictEqual(ed.graph.edges, []);
  });

  it("accepts every edge kind", () => {
    const ed = new GraphEditor(base());
    const out = ed.connect(EDGE_KINDS.map((kind) => ({ from: "a", to: "b", kind })));
    assert.ok(out.every((l) => l.startsWith("ok: a -")), out.join("\n"));
    assert.strictEqual(ed.graph.edges.length, EDGE_KINDS.length);
  });

  it("rejects a self-loop", () => {
    const ed = new GraphEditor(base());
    const out = ed.connect([
      { from: "a", to: "a", kind: "calls" },
      { from: "Cache.get", to: "cache_get", kind: "calls" },
    ]);
    assert.deepStrictEqual(out, [
      "error: edge a→a: a node cannot point to itself.",
      "error: edge cache_get→cache_get: a node cannot point to itself.",
    ]);
    assert.strictEqual(ed.changed, false);
  });

  it("a duplicate edge says it already exists and adds nothing", () => {
    const ed = new GraphEditor(graph([node({ id: "a" }), node({ id: "b" })], [edge("a", "b", "calls", "x")]));
    const out = ed.connect([{ from: "a", to: "b", kind: "calls" }, { from: "a", to: "b", kind: "calls", label: "x" }]);
    assert.deepStrictEqual(out, ["ok: a -calls-> b already exists.", "ok: a -calls-> b already exists."]);
    assert.strictEqual(ed.graph.edges.length, 1);
    assert.strictEqual(ed.summary().edgesAdded, 0);
    assert.strictEqual(ed.changed, false);
  });

  it("a duplicate inside one batch is detected too", () => {
    const ed = new GraphEditor(base());
    const out = ed.connect([{ from: "a", to: "b", kind: "uses" }, { from: "a", to: "b", kind: "uses" }]);
    assert.deepStrictEqual(out, ["ok: a -uses-> b.", "ok: a -uses-> b already exists."]);
    assert.strictEqual(ed.summary().edgesAdded, 1);
  });

  it("the same pair with a different kind or direction is a new edge", () => {
    const ed = new GraphEditor(graph([node({ id: "a" }), node({ id: "b" })], [edge("a", "b", "calls")]));
    ed.connect([
      { from: "a", to: "b", kind: "uses" },
      { from: "b", to: "a", kind: "calls" },
    ]);
    assert.strictEqual(ed.graph.edges.length, 3);
    assert.strictEqual(ed.summary().edgesAdded, 2);
  });

  it("relabels an existing edge when given a different label", () => {
    const ed = new GraphEditor(graph([node({ id: "a" }), node({ id: "b" })], [edge("a", "b", "calls", "old")]));
    const out = ed.connect([{ from: "a", to: "b", kind: "calls", label: "  new  " }]);
    assert.deepStrictEqual(out, ["ok: relabeled a -calls-> b."]);
    assert.strictEqual(ed.graph.edges.length, 1);
    assert.strictEqual(ed.graph.edges[0].label, "new");
  });

  it("adds a label to an unlabeled existing edge", () => {
    const ed = new GraphEditor(graph([node({ id: "a" }), node({ id: "b" })], [edge("a", "b")]));
    const out = ed.connect([{ from: "a", to: "b", kind: "calls", label: "first" }]);
    assert.deepStrictEqual(out, ["ok: relabeled a -calls-> b."]);
    assert.strictEqual(ed.graph.edges[0].label, "first");
  });

  it("relabeling an edge counts as a change", () => {
    const ed = new GraphEditor(graph([node({ id: "a" }), node({ id: "b" })], [edge("a", "b", "calls", "old")]));
    ed.connect([{ from: "a", to: "b", kind: "calls", label: "new" }]);
    assert.strictEqual(ed.changed, true);
    assert.strictEqual(ed.result().revision, 4);
  });

  it("stops at MAX_EDGES with an error naming the cap", () => {
    const nodes = manyNodes(30);
    const edges: GraphEdge[] = [];
    for (let i = 0; i < nodes.length && edges.length < MAX_EDGES; i++) {
      for (let j = 0; j < nodes.length && edges.length < MAX_EDGES; j++) {
        if (i !== j) edges.push(edge(`n${i}`, `n${j}`, "calls"));
      }
    }
    assert.strictEqual(edges.length, MAX_EDGES);
    const ed = new GraphEditor(graph(nodes, edges));
    const [line] = ed.connect([{ from: "n0", to: "n1", kind: "uses" }]);
    assert.strictEqual(line, `error: the graph already has ${MAX_EDGES} edges.`);
    assert.strictEqual(ed.graph.edges.length, MAX_EDGES);
    assert.strictEqual(ed.changed, false);
  });

  it("an existing edge can still be matched when the graph is full", () => {
    const nodes = manyNodes(30);
    const edges: GraphEdge[] = [];
    for (let i = 0; i < nodes.length && edges.length < MAX_EDGES; i++) {
      for (let j = 0; j < nodes.length && edges.length < MAX_EDGES; j++) {
        if (i !== j) edges.push(edge(`n${i}`, `n${j}`, "calls"));
      }
    }
    const ed = new GraphEditor(graph(nodes, edges));
    assert.deepStrictEqual(ed.connect([{ from: "n0", to: "n1", kind: "calls" }]), ["ok: n0 -calls-> n1 already exists."]);
  });
});

// ---------------------------------------------------------------- disconnect

describe("GraphEditor.disconnect", () => {
  const base = () =>
    graph(
      [node({ id: "a" }), node({ id: "b" }), node({ id: "cache_get" })],
      [edge("a", "b", "calls"), edge("a", "b", "uses"), edge("b", "a", "calls"), edge("a", "cache_get", "reads")],
    );

  it("with a kind, removes only that edge", () => {
    const ed = new GraphEditor(base());
    const out = ed.disconnect([{ from: "a", to: "b", kind: "calls" }]);
    assert.deepStrictEqual(out, ["ok: removed 1 edge(s) a→b."]);
    assert.deepStrictEqual(ed.graph.edges, [edge("a", "b", "uses"), edge("b", "a", "calls"), edge("a", "cache_get", "reads")]);
    assert.strictEqual(ed.summary().edgesRemoved, 1);
  });

  it("without a kind, removes every edge in that direction", () => {
    const ed = new GraphEditor(base());
    const out = ed.disconnect([{ from: "a", to: "b" }]);
    assert.deepStrictEqual(out, ["ok: removed 2 edge(s) a→b."]);
    assert.deepStrictEqual(ed.graph.edges, [edge("b", "a", "calls"), edge("a", "cache_get", "reads")]);
    assert.strictEqual(ed.summary().edgesRemoved, 2);
  });

  it("is directional", () => {
    const ed = new GraphEditor(base());
    ed.disconnect([{ from: "b", to: "a" }]);
    assert.strictEqual(ed.graph.edges.length, 3);
    assert.ok(ed.graph.edges.every((e) => !(e.from === "b" && e.to === "a")));
  });

  it("matches non-normalized ids", () => {
    const ed = new GraphEditor(base());
    assert.deepStrictEqual(ed.disconnect([{ from: "A", to: "Cache.get" }]), ["ok: removed 1 edge(s) A→Cache.get."]);
    assert.strictEqual(ed.graph.edges.length, 3);
  });

  it("reports a missing edge, mentioning the kind when given", () => {
    const ed = new GraphEditor(base());
    const out = ed.disconnect([
      { from: "cache_get", to: "a" },
      { from: "a", to: "b", kind: "returns" },
    ]);
    assert.deepStrictEqual(out, ["error: no edge cache_get→a.", "error: no edge a→b of kind returns."]);
    assert.strictEqual(ed.changed, false);
    assert.strictEqual(ed.graph.edges.length, 4);
  });

  it("removing the same edge twice errors the second time", () => {
    const ed = new GraphEditor(base());
    const out = ed.disconnect([{ from: "a", to: "cache_get" }, { from: "a", to: "cache_get" }]);
    assert.strictEqual(out[0], "ok: removed 1 edge(s) a→cache_get.");
    assert.strictEqual(out[1], "error: no edge a→cache_get.");
  });
});

// ---------------------------------------------------------------- summary / result

describe("GraphEditor summary, changed and result", () => {
  it("a fresh editor reports no change and returns an equal graph with the same revision", () => {
    const original = graph([node({ id: "a" })]);
    const ed = new GraphEditor(original);
    assert.strictEqual(ed.changed, false);
    assert.deepStrictEqual(ed.summary(), emptySummary());
    const r = ed.result();
    assert.strictEqual(r.revision, 3);
    assert.strictEqual(r.updatedAt, OLD_STAMP);
    assert.deepStrictEqual(r, original);
  });

  it("failed operations do not count as changes", () => {
    const ed = new GraphEditor(graph([node({ id: "a" }), node({ id: "b" })]));
    ed.addNodes([{ id: "a", kind: "function", description: "dup" }]);
    ed.updateNodes([{ id: "ghost", set: { label: "x" } }]);
    ed.removeNodes(["ghost"]);
    ed.connect([{ from: "a", to: "a", kind: "calls" }]);
    ed.disconnect([{ from: "a", to: "b" }]);
    assert.strictEqual(ed.changed, false);
    assert.strictEqual(ed.result().revision, 3);
  });

  it("bumps the revision and timestamp once when something changed", () => {
    const ed = new GraphEditor(graph([node({ id: "a" })]));
    ed.addNodes([{ id: "b", kind: "function", description: "d" }]);
    ed.updateNodes([{ id: "a", set: { label: "A" } }]);
    const r1 = ed.result();
    const r2 = ed.result();
    assert.strictEqual(r1.revision, 4);
    assert.strictEqual(r2.revision, 4, "calling result() twice must not bump twice");
    assert.notStrictEqual(r1.updatedAt, OLD_STAMP);
    assert.ok(!Number.isNaN(Date.parse(r1.updatedAt)));
    assert.strictEqual(ed.graph.revision, 3, "the live graph keeps the original revision");
  });

  it("edge-only changes bump the revision", () => {
    const ed = new GraphEditor(graph([node({ id: "a" }), node({ id: "b" })]));
    ed.connect([{ from: "a", to: "b", kind: "calls" }]);
    assert.strictEqual(ed.result().revision, 4);
    const ed2 = new GraphEditor(graph([node({ id: "a" }), node({ id: "b" })], [edge("a", "b")]));
    ed2.disconnect([{ from: "a", to: "b" }]);
    assert.strictEqual(ed2.result().revision, 4);
  });

  it("result() is an independent copy", () => {
    const ed = new GraphEditor(graph([node({ id: "a" })]));
    ed.updateNodes([{ id: "a", set: { label: "A" } }]);
    const r = ed.result();
    r.nodes[0].label = "tampered";
    assert.strictEqual(ed.graph.nodes[0].label, "A");
  });

  it("summary() reflects a mixed batch", () => {
    const ed = new GraphEditor(graph([node({ id: "a" }), node({ id: "b" }), node({ id: "c" })], [edge("a", "b"), edge("b", "c")]));
    ed.addNodes([{ id: "d", kind: "function", description: "d" }]);
    ed.updateNodes([{ id: "a", set: { label: "A" } }]);
    ed.removeNodes(["c"]);
    ed.connect([{ from: "d", to: "a", kind: "uses" }]);
    assert.deepStrictEqual(ed.summary(), { added: ["d"], updated: ["a"], removed: ["c"], edgesAdded: 1, edgesRemoved: 1 });
  });
});

describe("describeSummary", () => {
  it("is empty for an empty summary", () => {
    assert.strictEqual(describeSummary(emptySummary()), "");
  });

  it("pluralizes nodes and edges", () => {
    assert.strictEqual(describeSummary({ ...emptySummary(), added: ["a"] }), "+1 node");
    assert.strictEqual(describeSummary({ ...emptySummary(), added: ["a", "b"] }), "+2 nodes");
    assert.strictEqual(describeSummary({ ...emptySummary(), edgesAdded: 1 }), "+1 edge");
    assert.strictEqual(describeSummary({ ...emptySummary(), edgesAdded: 3 }), "+3 edges");
    assert.strictEqual(describeSummary({ ...emptySummary(), edgesRemoved: 1 }), "−1 edge");
    assert.strictEqual(describeSummary({ ...emptySummary(), edgesRemoved: 4 }), "−4 edges");
  });

  it("lists updated and removed counts without pluralizing", () => {
    assert.strictEqual(describeSummary({ ...emptySummary(), updated: ["a", "b"] }), "~2 updated");
    assert.strictEqual(describeSummary({ ...emptySummary(), removed: ["a", "b", "c"] }), "−3 removed");
  });

  it("joins the parts in a fixed order", () => {
    assert.strictEqual(
      describeSummary({ added: ["a", "b"], updated: ["c"], removed: ["d"], edgesAdded: 2, edgesRemoved: 1 }),
      "+2 nodes, ~1 updated, −1 removed, +2 edges, −1 edge",
    );
  });
});

// ---------------------------------------------------------------- findSymbol / syncWithOutline

describe("findSymbol", () => {
  const symbols = [sym("Cache", { kind: "class" }), sym("Cache.get", { kind: "method" }), sym("Other.get", { kind: "method" }), sym("fetch")];

  it("matches an exact qualified name", () => {
    assert.strictEqual(findSymbol(node({ id: "x", symbol: "Cache.get" }), symbols), symbols[1]);
    assert.strictEqual(findSymbol(node({ id: "x", symbol: "Other.get" }), symbols), symbols[2]);
  });

  it("matches a unique short name", () => {
    assert.strictEqual(findSymbol(node({ id: "x", symbol: "fetch" }), symbols), symbols[3]);
    assert.strictEqual(findSymbol(node({ id: "x", symbol: "Whatever.fetch" }), symbols), symbols[3]);
  });

  it("an ambiguous short name matches nothing", () => {
    assert.strictEqual(findSymbol(node({ id: "x", symbol: "get" }), symbols), undefined);
    assert.strictEqual(findSymbol(node({ id: "x", symbol: "Third.get" }), symbols), undefined);
  });

  it("an exact qualname wins over the ambiguity of its short name", () => {
    assert.strictEqual(findSymbol(node({ id: "x", symbol: "Cache.get" }), symbols)?.qualname, "Cache.get");
  });

  it("returns undefined for a name that is not in the code", () => {
    assert.strictEqual(findSymbol(node({ id: "x", symbol: "missing" }), symbols), undefined);
    assert.strictEqual(findSymbol(node({ id: "x", symbol: "Cache.missing" }), symbols), undefined);
  });

  it("strips declaration keywords and parameter lists the model may have written", () => {
    const wanted = (symbol: string, expected: OutlineSymbol) => assert.strictEqual(findSymbol(node({ id: "x", symbol }), symbols), expected, symbol);
    wanted("def fetch(repo: str) -> list", symbols[3]);
    wanted("async def fetch(repo)", symbols[3]);
    wanted("def Cache.get(self, key)", symbols[1]);
    wanted("class Cache(Base):", symbols[0]);
    wanted("function fetch<T>(x: T)", symbols[3]);
    wanted("const fetch = async () =>", symbols[3]);
  });

  it("uses the label for symbol-like kinds that have no symbol", () => {
    assert.strictEqual(findSymbol(node({ id: "x", kind: "function", label: "fetch" }), symbols), symbols[3]);
    assert.strictEqual(findSymbol(node({ id: "x", kind: "class", label: "Cache" }), symbols), symbols[0]);
    assert.strictEqual(findSymbol(node({ id: "x", kind: "method", label: "Cache.get" }), symbols), symbols[1]);
  });

  it("does not use the label for step, external or module nodes", () => {
    for (const kind of ["step", "external", "module"] as const) {
      assert.strictEqual(findSymbol(node({ id: "x", kind, label: "fetch" }), symbols), undefined, kind);
    }
  });

  it("a symbol takes precedence over the label", () => {
    assert.strictEqual(findSymbol(node({ id: "x", kind: "function", label: "Cache", symbol: "fetch" }), symbols), symbols[3]);
  });
});

describe("syncWithOutline", () => {
  it("a symbol with a real body is done, a placeholder body is stubbed, a missing symbol is planned", () => {
    const g = graph([node({ id: "real", symbol: "real" }), node({ id: "stub", symbol: "stub" }), node({ id: "gone", symbol: "gone" })]);
    const changed = syncWithOutline(g, outlineOf(sym("real", { line: 4 }), sym("stub", { line: 9, isStub: true })));
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(
      g.nodes.map((n) => [n.id, n.status, n.line]),
      [
        ["real", "done", 4],
        ["stub", "stubbed", 9],
        ["gone", "planned", undefined],
      ],
    );
  });

  it("returns true only when something changed", () => {
    const g = graph([node({ id: "a", symbol: "a" })]);
    const o = outlineOf(sym("a", { line: 2 }));
    assert.strictEqual(syncWithOutline(g, o), true);
    assert.strictEqual(syncWithOutline(g, o), false);
    assert.strictEqual(syncWithOutline(g, o), false);
  });

  it("returns false for a graph that is already in sync with an empty outline", () => {
    const g = graph([node({ id: "a", symbol: "a" })]);
    assert.strictEqual(syncWithOutline(g, outlineOf()), false);
    assert.strictEqual(g.nodes[0].status, "planned");
  });

  it("an empty graph never changes", () => {
    assert.strictEqual(syncWithOutline(graph(), outlineOf(sym("a"))), false);
  });

  it("a moved symbol updates the line (and counts as a change)", () => {
    const g = graph([node({ id: "a", symbol: "a", status: "done", line: 3 })]);
    assert.strictEqual(syncWithOutline(g, outlineOf(sym("a", { line: 8 }))), true);
    assert.strictEqual(g.nodes[0].line, 8);
    assert.strictEqual(g.nodes[0].status, "done");
  });

  it("line 0 is a real line, not 'missing'", () => {
    const g = graph([node({ id: "a", symbol: "a" })]);
    syncWithOutline(g, outlineOf(sym("a", { line: 0 })));
    assert.strictEqual(g.nodes[0].line, 0);
    assert.strictEqual(g.nodes[0].status, "done");
  });

  it("a stub that gets a body becomes done, and a done node whose symbol was deleted goes back to planned and loses its line", () => {
    const g = graph([node({ id: "a", symbol: "a", status: "stubbed", line: 1 }), node({ id: "b", symbol: "b", status: "done", line: 5 })]);
    assert.strictEqual(syncWithOutline(g, outlineOf(sym("a", { line: 1 }))), true);
    assert.deepStrictEqual(
      g.nodes.map((n) => [n.status, n.line]),
      [
        ["done", 1],
        ["planned", undefined],
      ],
    );
  });

  it("keeps 'attention' while still tracking the line", () => {
    const g = graph([
      node({ id: "a", symbol: "a", status: "attention", attention: "why", line: 1 }),
      node({ id: "b", symbol: "b", status: "attention", attention: "why", line: 4 }),
    ]);
    syncWithOutline(g, outlineOf(sym("a", { line: 6 })));
    assert.strictEqual(g.nodes[0].status, "attention");
    assert.strictEqual(g.nodes[0].line, 6);
    assert.strictEqual(g.nodes[0].attention, "why");
    assert.strictEqual(g.nodes[1].status, "attention", "attention survives the symbol disappearing");
    assert.strictEqual(g.nodes[1].line, undefined);
  });

  it("an attention node whose line is unchanged is not reported as a change", () => {
    const g = graph([node({ id: "a", symbol: "a", status: "attention", attention: "why", line: 2 })]);
    assert.strictEqual(syncWithOutline(g, outlineOf(sym("a", { line: 2 }))), false);
  });

  it("matches by label for symbol-like kinds without a symbol", () => {
    const g = graph([node({ id: "f", kind: "function", label: "fetch" }), node({ id: "c", kind: "class", label: "Cache" })]);
    syncWithOutline(g, outlineOf(sym("fetch", { line: 3 }), sym("Cache", { kind: "class", line: 10, isStub: true })));
    assert.deepStrictEqual(
      g.nodes.map((n) => [n.status, n.line]),
      [
        ["done", 3],
        ["stubbed", 10],
      ],
    );
  });

  it("syncs data, constant and test nodes too", () => {
    const g = graph([node({ id: "d", kind: "data", label: "Issue" }), node({ id: "k", kind: "constant", label: "MAX" }), node({ id: "t", kind: "test", label: "test_it" })]);
    syncWithOutline(g, outlineOf(sym("Issue", { line: 1 }), sym("MAX", { line: 2 }), sym("test_it", { line: 3 })));
    assert.deepStrictEqual(
      g.nodes.map((n) => n.status),
      ["done", "done", "done"],
    );
  });

  it("leaves step, external and module nodes without a symbol untouched", () => {
    const g = graph([
      node({ id: "s", kind: "step", label: "fetch", status: "done", line: 99 }),
      node({ id: "e", kind: "external", label: "fetch", status: "planned" }),
      node({ id: "m", kind: "module", label: "fetch", status: "stubbed" }),
    ]);
    const before = cloneGraph(g);
    assert.strictEqual(syncWithOutline(g, outlineOf(sym("fetch", { line: 1 }))), false);
    assert.deepStrictEqual(g, before);
  });

  it("syncs a step or external node that does name a symbol", () => {
    const g = graph([node({ id: "s", kind: "step", symbol: "fetch" }), node({ id: "e", kind: "external", symbol: "helper" })]);
    assert.strictEqual(syncWithOutline(g, outlineOf(sym("fetch", { line: 2 }))), true);
    assert.strictEqual(g.nodes[0].status, "done");
    assert.strictEqual(g.nodes[0].line, 2);
    assert.strictEqual(g.nodes[1].status, "planned");
  });

  it("an ambiguous short name leaves the node planned", () => {
    const g = graph([node({ id: "g", kind: "method", symbol: "get" })]);
    syncWithOutline(g, outlineOf(sym("Cache.get", { kind: "method" }), sym("Other.get", { kind: "method" })));
    assert.strictEqual(g.nodes[0].status, "planned");
    assert.strictEqual(g.nodes[0].line, undefined);
  });
});

describe("unplannedSymbols", () => {
  it("lists symbols that no node refers to, in outline order", () => {
    const planned = sym("fetch");
    const extra = sym("helper");
    const method = sym("Cache.get", { kind: "method" });
    const g = graph([node({ id: "f", symbol: "fetch" })]);
    assert.deepStrictEqual(unplannedSymbols(g, outlineOf(planned, extra, method)), [extra, method]);
  });

  it("excludes plain variables", () => {
    const v = sym("logger", { kind: "variable" });
    const c = sym("MAX_PAGES", { kind: "constant" });
    const t = sym("Issue", { kind: "type" });
    assert.deepStrictEqual(unplannedSymbols(graph(), outlineOf(v, c, t)), [c, t]);
  });

  it("counts a symbol as planned when a node matches it by label", () => {
    const g = graph([node({ id: "f", kind: "function", label: "fetch" })]);
    assert.deepStrictEqual(unplannedSymbols(g, outlineOf(sym("fetch"))), []);
  });

  it("is empty when everything is planned or there is no code", () => {
    assert.deepStrictEqual(unplannedSymbols(graph([node({ id: "f", symbol: "f" })]), outlineOf()), []);
    assert.deepStrictEqual(unplannedSymbols(graph([node({ id: "f", symbol: "f" })]), outlineOf(sym("f"))), []);
  });

  it("an ambiguous short name plans neither symbol", () => {
    const a = sym("A.get", { kind: "method" });
    const b = sym("B.get", { kind: "method" });
    const g = graph([node({ id: "g", kind: "method", symbol: "get" })]);
    assert.deepStrictEqual(unplannedSymbols(g, outlineOf(a, b)), [a, b]);
  });
});

// ---------------------------------------------------------------- orderedNodes

describe("orderedNodes", () => {
  const names = (g: FileGraph) => orderedNodes(g).map((n) => n.id);

  it("keeps insertion order when there are no edges or explicit orders", () => {
    assert.deepStrictEqual(names(graph([node({ id: "a" }), node({ id: "b" }), node({ id: "c" })])), ["a", "b", "c"]);
  });

  it("puts explicit orders first, ascending", () => {
    const g = graph([node({ id: "a" }), node({ id: "b", order: 2 }), node({ id: "c", order: 1 }), node({ id: "d" })]);
    assert.deepStrictEqual(names(g), ["c", "b", "a", "d"]);
  });

  it("explicit order beats dependencies", () => {
    const g = graph([node({ id: "caller", order: 1 }), node({ id: "callee", order: 2 }), node({ id: "free" })], [edge("caller", "callee")]);
    assert.deepStrictEqual(names(g), ["caller", "callee", "free"]);
  });

  it("places dependencies before their dependents", () => {
    const g = graph([node({ id: "a" }), node({ id: "b" }), node({ id: "c" })], [edge("a", "b"), edge("b", "c")]);
    assert.deepStrictEqual(names(g), ["c", "b", "a"]);
  });

  it("only moves a dependency ahead of its dependent, leaving unrelated nodes in place", () => {
    const g = graph([node({ id: "a" }), node({ id: "b" }), node({ id: "c" })], [edge("a", "c")]);
    assert.deepStrictEqual(names(g), ["c", "a", "b"]);
  });

  it("treats every edge kind except contains as a dependency", () => {
    for (const kind of EDGE_KINDS.filter((k) => k !== "contains")) {
      const g = graph([node({ id: "user" }), node({ id: "used" })], [edge("user", "used", kind)]);
      assert.deepStrictEqual(names(g), ["used", "user"], kind);
    }
  });

  it("ignores contains edges", () => {
    const g = graph([node({ id: "module", kind: "module" }), node({ id: "klass", kind: "class" }), node({ id: "meth", kind: "method" })], [
      edge("module", "klass", "contains"),
      edge("klass", "meth", "contains"),
    ]);
    assert.deepStrictEqual(names(g), ["module", "klass", "meth"]);
  });

  it("breaks ties among equal explicit orders by dependency", () => {
    const g = graph([node({ id: "a", order: 1 }), node({ id: "b", order: 1 })], [edge("a", "b")]);
    assert.deepStrictEqual(names(g), ["b", "a"]);
  });

  it("handles a diamond", () => {
    const g = graph(
      [node({ id: "top" }), node({ id: "left" }), node({ id: "right" }), node({ id: "bottom" })],
      [edge("top", "left"), edge("top", "right"), edge("left", "bottom"), edge("right", "bottom")],
    );
    const out = names(g);
    assert.strictEqual(out.length, 4);
    assert.ok(out.indexOf("bottom") < out.indexOf("left"));
    assert.ok(out.indexOf("bottom") < out.indexOf("right"));
    assert.ok(out.indexOf("left") < out.indexOf("top"));
    assert.ok(out.indexOf("right") < out.indexOf("top"));
  });

  it("does not hang on cycles and returns every node exactly once", () => {
    const two = graph([node({ id: "a" }), node({ id: "b" })], [edge("a", "b"), edge("b", "a")]);
    assert.deepStrictEqual([...names(two)].sort(), ["a", "b"]);
    const three = graph(
      [node({ id: "a" }), node({ id: "b" }), node({ id: "c" }), node({ id: "d" })],
      [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("d", "a")],
    );
    const out = names(three);
    assert.deepStrictEqual([...out].sort(), ["a", "b", "c", "d"]);
    assert.ok(out.indexOf("a") < out.indexOf("d"), "d depends on the cycle, so it comes after it");
  });

  it("does not hang on a cycle combined with explicit orders", () => {
    const g = graph([node({ id: "a", order: 2 }), node({ id: "b", order: 1 })], [edge("a", "b"), edge("b", "a")]);
    assert.deepStrictEqual(names(g), ["b", "a"]);
  });

  it("returns a new array and leaves the graph untouched", () => {
    const g = graph([node({ id: "a" }), node({ id: "b" })], [edge("a", "b")]);
    const out = orderedNodes(g);
    assert.notStrictEqual(out, g.nodes);
    assert.deepStrictEqual(ids(g), ["a", "b"]);
    assert.strictEqual(out[0], g.nodes[1], "returns the same node objects");
  });

  it("is empty for an empty graph", () => {
    assert.deepStrictEqual(orderedNodes(graph()), []);
  });

  it("ignores an edge to a node that does not exist", () => {
    const g = graph([node({ id: "a" }), node({ id: "b" })], [edge("a", "ghost"), edge("ghost", "b")]);
    assert.deepStrictEqual(names(g), ["a", "b"]);
  });
});

// ---------------------------------------------------------------- renderings

describe("compactGraph", () => {
  it("renders an empty graph", () => {
    assert.strictEqual(compactGraph(graph()), "(empty graph)");
  });

  it("lists nodes with kind, status, 1-based line, order and symbol", () => {
    const g = graph([
      node({ id: "cache_get", kind: "method", symbol: "Cache.get", status: "done", line: 11, order: 2, description: "Look up a key." }),
      node({ id: "fetch", description: "Fetch issues." }),
    ]);
    const text = compactGraph(g);
    const lines = text.split("\n");
    assert.strictEqual(lines[0], "nodes (2):");
    assert.ok(lines.includes("- cache_get [method, done, L12, order 2] symbol=Cache.get"), text);
    assert.ok(lines.includes("    Look up a key."), text);
    assert.ok(lines.includes("- fetch [function, planned]"), text);
    assert.ok(!text.includes("edges ("), "no edge section when there are no edges");
  });

  it("shows line 0 as L1", () => {
    const text = compactGraph(graph([node({ id: "a", line: 0, status: "done" })]));
    assert.ok(text.includes("- a [function, done, L1]"), text);
  });

  it("includes signatures, notes and attention reasons", () => {
    const g = graph([
      node({ id: "a", signature: "def a(x: int) -> str", notes: ["handle None", "O(n)"], status: "attention", attention: "off by one" }),
    ]);
    const lines = compactGraph(g).split("\n");
    assert.ok(lines.includes("    sig: def a(x: int) -> str"));
    assert.ok(lines.includes("    • handle None"));
    assert.ok(lines.includes("    • O(n)"));
    assert.ok(lines.includes("    ⚠ off by one"));
  });

  it("lists edges, with labels when present", () => {
    const g = graph([node({ id: "a" }), node({ id: "b" })], [edge("a", "b", "calls", "with retry"), edge("b", "a", "uses")]);
    const lines = compactGraph(g).split("\n");
    assert.ok(lines.includes("edges (2):"));
    assert.ok(lines.includes("- a -calls-> b (with retry)"));
    assert.ok(lines.includes("- b -uses-> a"));
  });

  it("lists nodes in typing order", () => {
    const g = graph([node({ id: "caller" }), node({ id: "callee" })], [edge("caller", "callee")]);
    const text = compactGraph(g);
    assert.ok(text.indexOf("- callee [") < text.indexOf("- caller ["), text);
  });
});

describe("graphForJev", () => {
  it("reduces nodes to id, kind, symbol, signature, status and purpose, and edges to strings", () => {
    const g = graph(
      [node({ id: "a", symbol: "a", signature: "def a()", description: "Does a.", notes: ["private"], status: "stubbed" }), node({ id: "b" })],
      [edge("a", "b", "calls", "label ignored")],
    );
    assert.deepStrictEqual(JSON.parse(JSON.stringify(graphForJev(g))), {
      nodes: [
        { id: "a", kind: "function", symbol: "a", signature: "def a()", status: "stubbed", purpose: "Does a." },
        { id: "b", kind: "function", status: "planned", purpose: "does b" },
      ],
      edges: ["a calls b"],
    });
  });
});

describe("toMermaid", () => {
  it("starts with the flowchart header and ends with the class definitions", () => {
    const lines = toMermaid(graph()).split("\n");
    assert.strictEqual(lines[0], "flowchart TD");
    assert.deepStrictEqual(lines.slice(1), [
      "  classDef planned stroke-dasharray: 4 3;",
      "  classDef stubbed fill:#fff3c4;",
      "  classDef done fill:#d7f5dc;",
      "  classDef attention fill:#ffd6d6,stroke:#d33;",
    ]);
  });

  it("emits one line per node with its status class", () => {
    const g = graph([node({ id: "fetch", label: "fetch", status: "done" }), node({ id: "cache_get", label: "Cache.get", status: "attention" })]);
    const lines = toMermaid(g).split("\n");
    assert.ok(lines.includes('  fetch["fetch"]:::done'), lines.join("\n"));
    assert.ok(lines.includes('  cache_get["Cache.get"]:::attention'), lines.join("\n"));
  });

  it("puts the signature under the label", () => {
    const g = graph([node({ id: "a", label: "a", signature: "def a(x)" })]);
    assert.ok(toMermaid(g).includes('  a["a<br/><small>def a(x)</small>"]:::planned'));
  });

  it("emits an edge line with its kind and label", () => {
    const g = graph([node({ id: "a" }), node({ id: "b" })], [edge("a", "b", "calls"), edge("b", "a", "uses", "why not")]);
    const lines = toMermaid(g).split("\n");
    assert.ok(lines.includes("  a -->|calls| b"), lines.join("\n"));
    assert.ok(lines.includes("  b -->|uses: why not| a"), lines.join("\n"));
  });

  it("escapes double quotes in labels, signatures and edge labels", () => {
    const g = graph(
      [node({ id: "a", label: 'say "hi"', signature: 'def a(s="x")' }), node({ id: "b" })],
      [edge("a", "b", "calls", 'says "x"')],
    );
    const text = toMermaid(g);
    assert.ok(text.includes('a["say #quot;hi#quot;<br/><small>def a(s=#quot;x#quot;)</small>"]:::planned'), text);
    assert.ok(text.includes("a -->|calls: says #quot;x#quot;| b"), text);
    const nodeLine = text.split("\n").find((l) => l.startsWith("  a["))!;
    assert.strictEqual((nodeLine.match(/"/g) ?? []).length, 2, "only the delimiting quotes remain");
  });

  it("escapes angle brackets in signatures and edge labels", () => {
    const g = graph([node({ id: "a", signature: "def a() -> list[Issue] | Map<K, V>" }), node({ id: "b" })], [edge("a", "b", "returns", "List<T>")]);
    const text = toMermaid(g);
    assert.ok(text.includes("Map#lt;K, V#gt;"), text);
    assert.ok(text.includes("returns: List#lt;T#gt;"), text);
    assert.ok(!/<(?!br\/>|small>|\/small>)/.test(text.split("\n").filter((l) => !l.includes("classDef")).join("\n")), "no stray raw '<'");
  });

  it("escapes angle brackets in node labels like it does in signatures", () => {
    const g = graph([node({ id: "a", label: "Array<T>" })]);
    assert.ok(toMermaid(g).includes('a["Array#lt;T#gt;"]'));
  });

  it("renders every node and edge of a larger graph", () => {
    const g = graph(
      [node({ id: "main", kind: "function" }), node({ id: "load", kind: "function" }), node({ id: "cfg", kind: "data" })],
      [edge("main", "load"), edge("load", "cfg", "reads")],
    );
    const text = toMermaid(g);
    for (const id of ["main", "load", "cfg"]) {
      assert.ok(text.includes(`  ${id}["`), id);
    }
    assert.ok(text.includes("main -->|calls| load"));
    assert.ok(text.includes("load -->|reads| cfg"));
  });
});
