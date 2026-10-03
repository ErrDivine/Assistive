// The implementation graph: validated batch edits (what the LLM's tools call),
// status sync with the code outline, and text renderings for prompts and export.
// Pure: no `vscode` import.

import {
  EDGE_KINDS,
  type EdgeKind,
  type FileGraph,
  type GraphChangeSummary,
  type GraphEdge,
  type GraphNode,
  NODE_KINDS,
  type NodeKind,
  type NodeStatus,
} from "../types";
import type { FileOutline, OutlineSymbol } from "../code/outline";
import { orderedNodes } from "./order";

export { orderedNodes };

export const MAX_NODES = 60;
export const MAX_EDGES = 150;
const MAX_NOTES = 8;
const MAX_TEXT = 600;

export interface NodeInput {
  id: string;
  kind: string;
  label?: string;
  symbol?: string;
  signature?: string;
  description: string;
  notes?: string[];
  order?: number;
}

export interface NodePatch {
  kind?: string;
  label?: string;
  symbol?: string;
  signature?: string;
  description?: string;
  notes?: string[];
  order?: number;
  status?: string;
  /** Empty string clears it. */
  attention?: string;
}

export interface NodeUpdate {
  id: string;
  set?: NodePatch;
  append_notes?: string[];
}

export interface EdgeInput {
  from: string;
  to: string;
  kind: string;
  label?: string;
}

export function emptyGraph(file: string, language: string, moduleString: string): FileGraph {
  return { file, language, moduleString, nodes: [], edges: [], revision: 0, updatedAt: new Date().toISOString() };
}

export function cloneGraph(g: FileGraph): FileGraph {
  return structuredClone(g);
}

/** `Cache.get` → `cache_get`; `fetchIssues` → `fetch_issues`. */
export function slugify(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48)
    .replace(/_+$/, "");
}

export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** The candidate nearest to `wanted` within a small edit distance, for "Did you mean" hints. */
export function closest(wanted: string, candidates: readonly string[]): string | undefined {
  return candidates
    .map((x) => ({ x, d: editDistance(x, wanted) }))
    .filter((c) => c.d <= Math.max(2, Math.floor(wanted.length / 3)))
    .sort((a, b) => a.d - b.d)[0]?.x;
}

function clip(s: string | undefined, max = MAX_TEXT): string {
  const t = (s ?? "").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function cleanNotes(notes: unknown): string[] {
  return Array.isArray(notes)
    ? notes
        .filter((n): n is string => typeof n === "string" && n.trim() !== "")
        .map((n) => clip(n, 300))
        .slice(0, MAX_NOTES)
    : [];
}

const STATUSES: NodeStatus[] = ["planned", "stubbed", "done", "attention"];

/**
 * Applies a batch of edits to a copy of a graph. Every method returns one
 * line per item ("ok …" or "error …") so the model can correct itself.
 */
export class GraphEditor {
  private readonly g: FileGraph;
  private readonly added = new Set<string>();
  private readonly updated = new Set<string>();
  private readonly removed = new Set<string>();
  private readonly removalReasons: Record<string, string> = {};
  private edgesAdded = 0;
  private edgesRemoved = 0;
  private edgesRelabeled = 0;

  constructor(graph: FileGraph) {
    this.g = cloneGraph(graph);
  }

  get graph(): FileGraph {
    return this.g;
  }

  private node(id: string): GraphNode | undefined {
    return this.g.nodes.find((n) => n.id === id);
  }

  /** "unknown node id 'x'. Did you mean 'y'? Existing ids: …" */
  unknownId(id: string): string {
    const ids = this.g.nodes.map((n) => n.id);
    const close = closest(id, ids);
    const hint = close ? ` Did you mean '${close}'?` : "";
    const list = ids.length ? ` Existing ids: ${ids.join(", ")}.` : " The graph has no nodes yet.";
    return `unknown node id '${id}'.${hint}${list}`;
  }

  addNodes(inputs: NodeInput[]): string[] {
    const out: string[] = [];
    for (const raw of inputs) {
      const id = slugify(raw.id || raw.symbol || raw.label || "");
      if (!id) {
        out.push("error: a node needs an id (snake_case slug).");
        continue;
      }
      if (this.node(id)) {
        out.push(`error: node '${id}' already exists; use update_nodes to change it.`);
        continue;
      }
      if (!(NODE_KINDS as readonly string[]).includes(raw.kind)) {
        out.push(`error: node '${id}': kind '${raw.kind}' is not one of ${NODE_KINDS.join(", ")}.`);
        continue;
      }
      if (!raw.description?.trim()) {
        out.push(`error: node '${id}' needs a description.`);
        continue;
      }
      if (this.g.nodes.length >= MAX_NODES) {
        out.push(`error: the graph already has ${MAX_NODES} nodes; merge or remove some first.`);
        break;
      }
      const node: GraphNode = {
        id,
        kind: raw.kind as NodeKind,
        label: clip(raw.label || raw.symbol || id, 60),
        symbol: raw.symbol?.trim() || undefined,
        signature: raw.signature?.trim() ? clip(raw.signature, 400) : undefined,
        description: clip(raw.description),
        notes: cleanNotes(raw.notes),
        order: typeof raw.order === "number" && raw.order > 0 ? Math.round(raw.order) : undefined,
        status: "planned",
      };
      this.g.nodes.push(node);
      this.added.add(id);
      out.push(id === raw.id ? `ok: added '${id}'.` : `ok: added '${id}' (id normalized from '${raw.id}').`);
    }
    return out;
  }

  updateNodes(updates: NodeUpdate[]): string[] {
    const out: string[] = [];
    for (const u of updates) {
      const node = this.node(u.id) ?? this.node(slugify(u.id));
      if (!node) {
        out.push(`error: ${this.unknownId(u.id)}`);
        continue;
      }
      const set = u.set ?? {};
      const changed: string[] = [];
      // Validate everything first so a rejected update changes nothing.
      if (set.kind !== undefined && !(NODE_KINDS as readonly string[]).includes(set.kind)) {
        out.push(`error: node '${node.id}': kind '${set.kind}' is not one of ${NODE_KINDS.join(", ")}.`);
        continue;
      }
      if (set.status !== undefined && !(STATUSES as string[]).includes(set.status)) {
        out.push(`error: node '${node.id}': status must be one of ${STATUSES.join(", ")}.`);
        continue;
      }
      if (set.kind !== undefined) {
        node.kind = set.kind as NodeKind;
        changed.push("kind");
      }
      if (set.status !== undefined) {
        node.status = set.status as NodeStatus;
        changed.push("status");
      }
      if (set.label !== undefined) {
        node.label = clip(set.label, 60) || node.id;
        changed.push("label");
      }
      if (set.symbol !== undefined) {
        node.symbol = set.symbol.trim() || undefined;
        changed.push("symbol");
      }
      if (set.signature !== undefined) {
        node.signature = set.signature.trim() ? clip(set.signature, 400) : undefined;
        changed.push("signature");
      }
      if (set.description !== undefined && set.description.trim()) {
        node.description = clip(set.description);
        changed.push("description");
      }
      if (set.notes !== undefined) {
        node.notes = cleanNotes(set.notes);
        changed.push("notes");
      }
      if (set.order !== undefined) {
        node.order = set.order > 0 ? Math.round(set.order) : undefined;
        changed.push("order");
      }
      if (set.attention !== undefined) {
        const why = set.attention.trim();
        node.attention = why ? clip(why, 300) : undefined;
        if (why) {
          node.status = "attention";
        } else if (node.status === "attention") {
          node.status = node.line !== undefined ? "done" : "planned";
        }
        changed.push("attention");
      }
      if (u.append_notes?.length) {
        node.notes = [...node.notes, ...cleanNotes(u.append_notes)].slice(-MAX_NOTES);
        changed.push("notes+");
      }
      if (!changed.length) {
        out.push(`error: node '${node.id}': nothing to update (give 'set' fields or 'append_notes').`);
        continue;
      }
      if (!this.added.has(node.id)) {
        this.updated.add(node.id);
      }
      out.push(`ok: updated '${node.id}' (${changed.join(", ")}).`);
    }
    return out;
  }

  /** `reason` is kept in the change summary (shown with the change in the feed). */
  removeNodes(ids: string[], reason?: string): string[] {
    const out: string[] = [];
    for (const raw of ids) {
      const node = this.node(raw) ?? this.node(slugify(raw));
      if (!node) {
        out.push(`error: ${this.unknownId(raw)}`);
        continue;
      }
      this.g.nodes = this.g.nodes.filter((n) => n !== node);
      const before = this.g.edges.length;
      this.g.edges = this.g.edges.filter((e) => e.from !== node.id && e.to !== node.id);
      const dropped = before - this.g.edges.length;
      this.edgesRemoved += dropped;
      if (this.added.delete(node.id)) {
        // added and removed in the same batch: no net change
      } else {
        this.updated.delete(node.id);
        this.removed.add(node.id);
        if (reason?.trim()) {
          this.removalReasons[node.id] = clip(reason, 200);
        }
      }
      out.push(`ok: removed '${node.id}'${dropped ? ` and ${dropped} edge(s)` : ""}.`);
    }
    return out;
  }

  connect(edges: EdgeInput[]): string[] {
    const out: string[] = [];
    for (const e of edges) {
      const from = this.node(e.from) ?? this.node(slugify(e.from));
      const to = this.node(e.to) ?? this.node(slugify(e.to));
      if (!from || !to) {
        out.push(`error: ${this.unknownId(!from ? e.from : e.to)}`);
        continue;
      }
      if (!(EDGE_KINDS as readonly string[]).includes(e.kind)) {
        out.push(`error: edge ${from.id}→${to.id}: kind '${e.kind}' is not one of ${EDGE_KINDS.join(", ")}.`);
        continue;
      }
      if (from === to) {
        out.push(`error: edge ${from.id}→${to.id}: a node cannot point to itself.`);
        continue;
      }
      const existing = this.g.edges.find((x) => x.from === from.id && x.to === to.id && x.kind === e.kind);
      if (existing) {
        if (e.label?.trim() && existing.label !== clip(e.label, 60)) {
          existing.label = clip(e.label, 60);
          this.edgesRelabeled++;
          out.push(`ok: relabeled ${from.id} -${e.kind}-> ${to.id}.`);
        } else {
          out.push(`ok: ${from.id} -${e.kind}-> ${to.id} already exists.`);
        }
        continue;
      }
      if (this.g.edges.length >= MAX_EDGES) {
        out.push(`error: the graph already has ${MAX_EDGES} edges.`);
        break;
      }
      const edge: GraphEdge = { from: from.id, to: to.id, kind: e.kind as EdgeKind };
      if (e.label?.trim()) {
        edge.label = clip(e.label, 60);
      }
      this.g.edges.push(edge);
      this.edgesAdded++;
      out.push(`ok: ${from.id} -${e.kind}-> ${to.id}.`);
    }
    return out;
  }

  disconnect(edges: { from: string; to: string; kind?: string }[]): string[] {
    const out: string[] = [];
    for (const e of edges) {
      const from = slugify(e.from);
      const to = slugify(e.to);
      const match = (x: GraphEdge) =>
        (x.from === e.from || x.from === from) && (x.to === e.to || x.to === to) && (!e.kind || x.kind === e.kind);
      const n = this.g.edges.filter(match).length;
      if (!n) {
        out.push(`error: no edge ${e.from}→${e.to}${e.kind ? ` of kind ${e.kind}` : ""}.`);
        continue;
      }
      this.g.edges = this.g.edges.filter((x) => !match(x));
      this.edgesRemoved += n;
      out.push(`ok: removed ${n} edge(s) ${e.from}→${e.to}.`);
    }
    return out;
  }

  get changed(): boolean {
    return this.added.size + this.updated.size + this.removed.size + this.edgesAdded + this.edgesRemoved + this.edgesRelabeled > 0;
  }

  summary(): GraphChangeSummary {
    const s: GraphChangeSummary = {
      added: [...this.added],
      updated: [...this.updated],
      removed: [...this.removed],
      edgesAdded: this.edgesAdded,
      edgesRemoved: this.edgesRemoved,
    };
    const reasons = Object.entries(this.removalReasons).filter(([id]) => this.removed.has(id));
    if (reasons.length) {
      s.removalReasons = Object.fromEntries(reasons);
    }
    return s;
  }

  /** The edited graph with a bumped revision (unchanged graphs keep theirs). */
  result(): FileGraph {
    const g = cloneGraph(this.g);
    if (this.changed) {
      g.revision += 1;
      g.updatedAt = new Date().toISOString();
    }
    return g;
  }
}

export function emptySummary(): GraphChangeSummary {
  return { added: [], updated: [], removed: [], edgesAdded: 0, edgesRemoved: 0 };
}

export function describeSummary(s: GraphChangeSummary): string {
  const parts: string[] = [];
  if (s.added.length) parts.push(`+${s.added.length} node${s.added.length > 1 ? "s" : ""}`);
  if (s.updated.length) parts.push(`~${s.updated.length} updated`);
  if (s.removed.length) parts.push(`−${s.removed.length} removed`);
  if (s.edgesAdded) parts.push(`+${s.edgesAdded} edge${s.edgesAdded > 1 ? "s" : ""}`);
  if (s.edgesRemoved) parts.push(`−${s.edgesRemoved} edge${s.edgesRemoved > 1 ? "s" : ""}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------- outline sync

const SYMBOL_KINDS = new Set<NodeKind>(["class", "function", "method", "data", "constant", "test"]);

/** Bare dotted name from what the model wrote: `def Cache.get()` → `Cache.get`. */
function symbolName(s: string): string {
  return s
    .replace(/^(async\s+)?(def|class|function|const|let|var)\s+/, "")
    .replace(/[(:<\s].*$/, "")
    .trim();
}

export function findSymbol(node: GraphNode, symbols: OutlineSymbol[]): OutlineSymbol | undefined {
  const wanted = node.symbol ? symbolName(node.symbol) : SYMBOL_KINDS.has(node.kind) ? node.label : "";
  if (!wanted) {
    return undefined;
  }
  const exact = symbols.find((s) => s.qualname === wanted);
  if (exact) {
    return exact;
  }
  const last = wanted.split(".").pop()!;
  const byName = symbols.filter((s) => s.name === last);
  return byName.length === 1 ? byName[0] : undefined;
}

/**
 * Update node statuses and lines from the code: a symbol with a real body is
 * `done`, a placeholder body is `stubbed`, a missing one is `planned`.
 * `attention` is kept until the heartbeat clears it. Returns whether anything changed.
 */
export function syncWithOutline(graph: FileGraph, outline: FileOutline): boolean {
  let changed = false;
  for (const node of graph.nodes) {
    if (!SYMBOL_KINDS.has(node.kind) && !node.symbol) {
      continue;
    }
    const sym = findSymbol(node, outline.symbols);
    const line = sym?.line;
    let status: NodeStatus = sym ? (sym.isStub ? "stubbed" : "done") : "planned";
    if (node.status === "attention") {
      status = "attention";
    }
    if (node.line !== line || node.status !== status) {
      node.line = line;
      node.status = status;
      changed = true;
    }
  }
  return changed;
}

/** Flag the innermost node whose code contains `line` (0-based); returns its id. */
export function flagNodeAt(graph: FileGraph, outline: FileOutline, line: number, why: string): string | undefined {
  let best: { node: GraphNode; size: number } | undefined;
  for (const node of graph.nodes) {
    const sym = findSymbol(node, outline.symbols);
    if (sym && sym.line <= line && line <= sym.endLine && (!best || sym.endLine - sym.line < best.size)) {
      best = { node, size: sym.endLine - sym.line };
    }
  }
  if (!best) {
    return undefined;
  }
  best.node.attention = clip(why, 300);
  best.node.status = "attention";
  return best.node.id;
}

/** Clear attention flags with this reason (all flags when omitted); statuses are recomputed from `outline`. */
export function clearAttention(graph: FileGraph, outline: FileOutline, why?: string): boolean {
  let changed = false;
  for (const node of graph.nodes) {
    if (node.status === "attention" && (why === undefined || node.attention === clip(why, 300))) {
      node.attention = undefined;
      node.status = "planned";
      changed = true;
    }
  }
  if (changed) {
    syncWithOutline(graph, outline);
  }
  return changed;
}

/** Symbols in the code that no node refers to (for sync prompts). */
export function unplannedSymbols(graph: FileGraph, outline: FileOutline): OutlineSymbol[] {
  const used = new Set(graph.nodes.map((n) => findSymbol(n, outline.symbols)).filter(Boolean));
  return outline.symbols.filter((s) => !used.has(s) && s.kind !== "variable");
}

// ---------------------------------------------------------------- rendering

/** Readable text for prompts. Lines are 1-based. */
export function compactGraph(graph: FileGraph): string {
  if (!graph.nodes.length) {
    return "(empty graph)";
  }
  const lines = [`nodes (${graph.nodes.length}):`];
  for (const n of orderedNodes(graph)) {
    const meta = [n.kind, n.status, n.line !== undefined ? `L${n.line + 1}` : "", n.order ? `order ${n.order}` : ""]
      .filter(Boolean)
      .join(", ");
    lines.push(`- ${n.id} [${meta}]${n.symbol ? ` symbol=${n.symbol}` : ""}`);
    if (n.signature) lines.push(`    sig: ${n.signature}`);
    lines.push(`    ${n.description}`);
    for (const note of n.notes) lines.push(`    • ${note}`);
    if (n.attention) lines.push(`    ⚠ ${n.attention}`);
  }
  if (graph.edges.length) {
    lines.push(`edges (${graph.edges.length}):`);
    for (const e of graph.edges) {
      lines.push(`- ${e.from} -${e.kind}-> ${e.to}${e.label ? ` (${e.label})` : ""}`);
    }
  }
  return lines.join("\n");
}

/** A small JSON shape for Jev's state. */
export function graphForJev(graph: FileGraph): unknown {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      symbol: n.symbol,
      signature: n.signature,
      status: n.status,
      purpose: n.description,
    })),
    edges: graph.edges.map((e) => `${e.from} ${e.kind} ${e.to}`),
  };
}

function mermaidText(s: string): string {
  return s.replace(/"/g, "#quot;").replace(/[<>]/g, (c) => (c === "<" ? "#lt;" : "#gt;"));
}

export function toMermaid(graph: FileGraph): string {
  const out = ["flowchart TD"];
  for (const n of graph.nodes) {
    const label = n.signature ? `${mermaidText(n.label)}<br/><small>${mermaidText(n.signature)}</small>` : mermaidText(n.label);
    out.push(`  ${n.id}["${label}"]:::${n.status}`);
  }
  for (const e of graph.edges) {
    out.push(`  ${e.from} -->|${e.kind}${e.label ? `: ${mermaidText(e.label)}` : ""}| ${e.to}`);
  }
  out.push(
    "  classDef planned stroke-dasharray: 4 3;",
    "  classDef stubbed fill:#fff3c4;",
    "  classDef done fill:#d7f5dc;",
    "  classDef attention fill:#ffd6d6,stroke:#d33;",
  );
  return out.join("\n");
}
