import * as assert from "node:assert";
import { conceptStatus, hierarchy, hierarchyPositions, projectHierarchy } from "../../src/graph/hierarchy";
import { emptyGraph, GraphEditor, syncWithOutline } from "../../src/graph/model";
import { progress } from "../../src/graph/order";
import { graphCard } from "../../src/panel/webview/graphCard";
import { ICON_PATHS } from "../../src/panel/webview/icons";
import { NODE_KINDS, type FileGraph, type GraphNode } from "../../src/types";

const node = (id: string, kind: GraphNode["kind"] = "function", status: GraphNode["status"] = "planned"): GraphNode =>
  ({ id, kind, status, label: id, description: "", notes: [] });
function fixture(): FileGraph {
  return { ...emptyGraph("app.py", "python", ""), nodes: [node("input", "concept"), node("output", "concept"), node("parse"), node("write"), node("validate", "step")], edges: [
    { from: "input", to: "parse", kind: "contains" }, { from: "parse", to: "validate", kind: "contains" },
    { from: "output", to: "write", kind: "contains" }, { from: "write", to: "parse", kind: "calls" },
  ] };
}
describe("evolving graph hierarchy", () => {
  it("shows responsibility, implementation and detail levels with projected dependencies", () => {
    const g = fixture();
    assert.strictEqual(hierarchy(g).depth.get("validate"), 2);
    const overview = projectHierarchy(g, 0);
    assert.deepStrictEqual(overview.nodes.map((n) => n.id), ["input", "output"]);
    assert.deepStrictEqual(overview.edges, [{ from: "output", to: "input", kind: "calls" }]);
    assert.strictEqual(projectHierarchy(g, 1).nodes.length, 4);
    assert.strictEqual(projectHierarchy(g, 100).nodes.length, 5);
    assert.strictEqual(g.nodes.length, 5, "view changes never modify the plan");
  });
  it("keeps abstractions at the top even with cross-branch calls", () => {
    const positions = hierarchyPositions(fixture());
    assert.strictEqual(positions.get("input")!.y, positions.get("output")!.y);
    assert.ok(positions.get("parse")!.y > positions.get("input")!.y);
    assert.ok(positions.get("validate")!.y > positions.get("parse")!.y);
    assert.notStrictEqual(positions.get("parse")!.x, positions.get("write")!.x);
  });
  it("handles old cyclic or ambiguous containment without losing nodes", () => {
    const g = fixture();
    g.edges.push({ from: "validate", to: "input", kind: "contains" }, { from: "output", to: "parse", kind: "contains" });
    const h = hierarchy(g);
    assert.strictEqual(h.parent.get("input"), undefined);
    assert.strictEqual(h.parent.get("parse"), "input");
    assert.strictEqual(projectHierarchy(g, 100).nodes.length, g.nodes.length);
  });
  it("does not turn an abstraction into a phantom code symbol", () => {
    const editor = new GraphEditor(fixture());
    assert.match(editor.addNodes([{id: "group", kind: "concept", symbol: "fake", description: "A group"}])[0], /^error:/);
    assert.match(editor.updateNodes([{id: "input", set: {symbol: "fake"}}])[0], /^error:/);
    assert.strictEqual(editor.result().nodes[0].symbol, undefined);
  });
  it("rejects cycles and second parents but permits cross-branch dependency cycles", () => {
    const editor = new GraphEditor(fixture());
    assert.match(editor.connect([{ from: "validate", to: "input", kind: "contains" }])[0], /error:.*cycle/);
    assert.match(editor.connect([{ from: "output", to: "parse", kind: "contains" }])[0], /error:.*parent/);
    assert.match(editor.connect([{ from: "parse", to: "write", kind: "calls" }])[0], /^ok:/);
    assert.match(editor.disconnect([{ from: "input", to: "parse", kind: "contains" }])[0], /^ok:/);
    assert.match(editor.connect([{ from: "output", to: "parse", kind: "contains" }])[0], /^ok:/);
    assert.strictEqual(hierarchy(editor.result()).parent.get("parse"), "output");
  });
  it("rolls concept status up from descendants and excludes concepts from typing totals", () => {
    const g = fixture();
    g.nodes.find((n) => n.id === "parse")!.status = "done";
    g.nodes.find((n) => n.id === "validate")!.status = "done";
    assert.strictEqual(conceptStatus(g, "input"), "done");
    assert.strictEqual(progress(g).total, 2);
    g.nodes.find((n) => n.id === "validate")!.status = "attention";
    assert.strictEqual(conceptStatus(g, "input"), "attention");
    syncWithOutline(g, { language: "python", symbols: [], imports: [], parser: "regex", hasErrors: false });
    assert.strictEqual(g.nodes[0].status, "attention");
  });
});
describe("graph SVG artwork", () => {
  it("has an SVG icon for every node kind and safely encodes model-written text", () => {
    for (const kind of NODE_KINDS) assert.ok(ICON_PATHS[kind]);
    const palette = { fg: "#ccc", muted: "#aaa", node: "#222", accent: "#07f", planned: "#aaa", stubbed: "#db7", done: "#8c8", attention: "#f77" };
    const uri = graphCard({ ...node("a"), label: '<script>alert("x")</script>', signature: 'a(x: A&B)' }, 1, true, palette);
    const svg = decodeURIComponent(uri.slice(uri.indexOf(",") + 1));
    assert.ok(!svg.includes("<script>"));
    assert.ok(svg.includes("&lt;script&gt;"));
    assert.ok(svg.includes("A&amp;B"));
    assert.ok(svg.includes("NEXT STEP"));
  });
});
