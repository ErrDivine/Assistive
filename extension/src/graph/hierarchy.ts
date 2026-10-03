// Containment is a hierarchy; dependency edges can cross its branches.
// Old graphs remain valid, including ambiguous or cyclic saved containment.
import type { FileGraph, GraphEdge, GraphNode } from "../types";

export function hierarchy(graph: FileGraph): { parent: Map<string, string>; depth: Map<string, number> } {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const parent = new Map<string, string>();
  for (const e of graph.edges) {
    if (e.kind !== "contains" || !ids.has(e.from) || !ids.has(e.to) || parent.has(e.to) || e.from === e.to) continue;
    let ancestor: string | undefined = e.from;
    while (ancestor && ancestor !== e.to) ancestor = parent.get(ancestor);
    if (ancestor === e.to) continue;
    parent.set(e.to, e.from);
  }
  const depth = new Map<string, number>();
  for (const id of ids) {
    let d = 0;
    let at = parent.get(id);
    while (at) { d++; at = parent.get(at); }
    depth.set(id, d);
  }
  return { parent, depth };
}

/** Hide deeper nodes, lifting dependencies to the nearest visible ancestor. */
export function projectHierarchy(graph: FileGraph, maxDepth: number): FileGraph {
  const { parent, depth } = hierarchy(graph);
  const nodes = graph.nodes.filter((n) => depth.get(n.id)! <= maxDepth);
  const visible = new Set(nodes.map((n) => n.id));
  const owner = (id: string): string | undefined => {
    while (!visible.has(id)) {
      const p = parent.get(id);
      if (!p) return undefined;
      id = p;
    }
    return id;
  };
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const e of graph.edges) {
    // Containment may not be lifted: that would turn siblings into parents.
    if (e.kind === "contains" && (!visible.has(e.from) || !visible.has(e.to))) continue;
    const from = owner(e.from), to = owner(e.to);
    if (!from || !to || from === to) continue;
    const key = JSON.stringify([from, to, e.kind]);
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ ...e, from, to });
  }
  return { ...graph, nodes, edges };
}

/** Concept groups reflect descendants without adding extra pieces to type. */
export function conceptStatus(graph: FileGraph, id: string): GraphNode["status"] {
  const { parent } = hierarchy(graph);
  const descendants = graph.nodes.filter((n) => {
    if (n.kind === "concept" || n.kind === "module" || n.kind === "external") return false;
    let at = parent.get(n.id);
    while (at) { if (at === id) return true; at = parent.get(at); }
    return false;
  });
  if (!descendants.length) return "planned";
  if (descendants.some((n) => n.status === "attention")) return "attention";
  if (descendants.every((n) => n.status === "done")) return "done";
  return descendants.some((n) => n.status !== "planned") ? "stubbed" : "planned";
}

/** Place containment levels in rows. Dependencies never pull an abstraction down. */
export function hierarchyPositions(graph: FileGraph, width = 216, height = 108): Map<string, { x: number; y: number }> {
  const { parent, depth } = hierarchy(graph);
  const children = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const [child, owner] of parent) children.get(owner)!.push(child);
  const positions = new Map<string, { x: number; y: number }>();
  let slot = 0;
  const place = (id: string): number => {
    const descendants = children.get(id)!;
    const xs = descendants.map(place);
    const x = xs.length ? (xs[0] + xs[xs.length - 1]) / 2 : slot++ * (width + 28);
    positions.set(id, { x, y: depth.get(id)! * (height + 56) });
    return x;
  };
  for (const n of graph.nodes) if (!parent.has(n.id)) place(n.id);
  return positions;
}
