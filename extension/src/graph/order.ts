// Typing order of graph nodes. Imports only types so the webview can use it.

import type { FileGraph, GraphNode } from "../types";

/** Nodes in suggested typing order: explicit `order` first, then dependencies before dependents. */
export function orderedNodes(graph: FileGraph): GraphNode[] {
  const deps = new Map<string, Set<string>>(graph.nodes.map((n) => [n.id, new Set<string>()]));
  for (const e of graph.edges) {
    if (e.kind === "contains") {
      continue;
    }
    // A node is typed after the nodes it calls or uses.
    deps.get(e.from)?.add(e.to);
  }
  const seen = new Set<string>();
  const topo: GraphNode[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const visit = (id: string, stack: Set<string>) => {
    if (seen.has(id) || stack.has(id)) {
      return;
    }
    stack.add(id);
    for (const d of deps.get(id) ?? []) {
      visit(d, stack);
    }
    stack.delete(id);
    seen.add(id);
    topo.push(byId.get(id)!);
  };
  for (const n of graph.nodes) {
    visit(n.id, new Set());
  }
  const rank = new Map(topo.map((n, i) => [n.id, i]));
  return [...graph.nodes].sort((a, b) => {
    const oa = a.order ?? Infinity;
    const ob = b.order ?? Infinity;
    return oa !== ob ? oa - ob : rank.get(a.id)! - rank.get(b.id)!;
  });
}
