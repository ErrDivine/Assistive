// Typing order of graph nodes. Imports only types so the webview can use it.

import type { FileGraph, GraphNode } from "../types";

/** Nodes in suggested typing order: explicit `order` first, then dependencies before dependents. */
export function orderedNodes(graph: FileGraph): GraphNode[] {
  const deps = new Map<string, Set<string>>(graph.nodes.map((n) => [n.id, new Set<string>()]));
  for (const e of graph.edges) {
    // Edges to unknown nodes (e.g. a hand-edited saved graph) are ignored.
    if (e.kind === "contains" || !deps.has(e.to)) {
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

const CODE_KINDS = new Set<string>(["class", "function", "method", "data", "constant", "test"]);

/** Nodes the programmer types (not externals, plain steps or the module itself). */
export function typedNodes(graph: FileGraph): GraphNode[] {
  return orderedNodes(graph).filter((n) => n.kind !== "external" && n.kind !== "module" && (CODE_KINDS.has(n.kind) || !!n.symbol));
}

/** How far the programmer is: done / total typed nodes, and the next node to type (or fix) in typing order. */
export function progress(graph: FileGraph): { done: number; total: number; next?: GraphNode } {
  const typed = typedNodes(graph);
  return { done: typed.filter((n) => n.status === "done").length, total: typed.length, next: typed.find((n) => n.status !== "done") };
}
