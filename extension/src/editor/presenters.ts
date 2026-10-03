// The text that the editor surfaces show: the hover, the code lens, the status
// bar item, the interrupt squiggles, the planned-file picker and the Markdown
// export. Pure (no VS Code import), so unit tests cover it; the controller
// turns these values into VS Code objects.

import { orderedNodes, progress, toMermaid } from "../graph/model";
import type { FeedItem, FileGraph, GraphNode } from "../types";

type Interrupt = Extract<FeedItem, { kind: "interrupt" }>;

/** Escape text so that Markdown shows it literally. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, "\\$&");
}

/** Markdown reduced to one line of plain text (for diagnostics and toasts). */
export function plain(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[`*_>#]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** A fenced code block whose fence is longer than any backtick run in the code. */
export function codeBlock(code: string, language = ""): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}

function nodeName(n: GraphNode): string {
  return n.symbol ?? n.label;
}

// ------------------------------------------------------------ hover

/** The plan for one node, shown when the mouse is on its symbol. */
export function hoverMarkdown(graph: FileGraph, node: GraphNode, language: string): string {
  const step = orderedNodes(graph).findIndex((n) => n.id === node.id) + 1;
  const parts = [`**Assistive plan** · ${node.status === "done" ? "✓ done" : node.status} · step ${step} of ${graph.nodes.length}`];
  if (node.signature) parts.push(codeBlock(node.signature, language));
  parts.push(escapeMarkdown(node.description));
  if (node.notes.length) parts.push(node.notes.map((n) => `- ${escapeMarkdown(n)}`).join("\n"));
  if (node.attention) parts.push(`⚠ ${escapeMarkdown(node.attention)}`);
  return parts.join("\n\n");
}

// ------------------------------------------------------------ code lens

export interface LensItem {
  title: string;
  command: string;
  args?: unknown[];
  tooltip?: string;
}

/** Progress and the next piece, shown above the module docstring. Empty when nothing is planned. */
export function lensItems(graph: FileGraph | undefined): LensItem[] {
  const p = graph?.nodes.length ? progress(graph) : undefined;
  if (!p?.total) return [];
  const items: LensItem[] = [{ title: `$(type-hierarchy) Assistive: ${p.done}/${p.total} done`, command: "assistive.focus", tooltip: "Open the implementation graph" }];
  if (p.next) {
    items.push({
      title: `Next: ${p.next.signature ?? nodeName(p.next)}`,
      command: "assistive.showNode",
      args: [p.next.id],
      tooltip: p.next.description,
    });
  } else {
    items.push({ title: "All planned pieces are typed", command: "assistive.focus" });
  }
  return items;
}

// ------------------------------------------------------------ status bar

export interface StatusView {
  text: string;
  tooltip: string;
  /** Show the warning background (open interrupts and no request in progress). */
  warning: boolean;
}

export function statusView(s: { busy?: string; open: number; graph?: FileGraph }): StatusView {
  const p = s.graph?.nodes.length ? progress(s.graph) : undefined;
  const count = p?.total ? ` ${p.done}/${p.total}` : "";
  const plan = p?.total
    ? `Assistive: ${p.done} of ${p.total} pieces done${p.next ? ` · next: ${nodeName(p.next)}` : " · all done"}`
    : "Assistive: implementation graph";
  if (s.busy) {
    return { text: `$(sync~spin) ${s.busy.replace(/…$/, "")}`, tooltip: s.busy, warning: false };
  }
  if (s.open) {
    return {
      text: `$(type-hierarchy)${count} $(warning) ${s.open}`,
      tooltip: `${s.open} open note${s.open > 1 ? "s" : ""} from the assistant\n${plan}`,
      warning: true,
    };
  }
  return { text: `$(type-hierarchy)${count}`, tooltip: plan, warning: false };
}

// ------------------------------------------------------------ interrupts

export interface LineRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/**
 * The squiggle of an interrupt: from the first non-blank character of its
 * first line to the end of its last line, at least one character wide.
 */
export function interruptRange(f: Pick<Interrupt, "line" | "endLine">, firstText: string, lastText: string): LineRange {
  const endLine = Math.max(f.line, f.endLine ?? f.line);
  const startCol = firstText.length - firstText.trimStart().length;
  const endCol = endLine === f.line ? Math.max(firstText.length, startCol + 1) : Math.max(lastText.length, 1);
  return { startLine: f.line, startCol, endLine, endCol };
}

export function diagnosticLevel(severity: Interrupt["severity"]): "error" | "warning" | "information" {
  return severity >= 3 ? "error" : severity === 2 ? "warning" : "information";
}

export function diagnosticMessage(f: Pick<Interrupt, "title" | "message">): string {
  return `${f.title}: ${plain(f.message)}`;
}

/** The open interrupt that a squiggle shows: the same start line and message. */
export function noteForDiagnostic<T extends Pick<Interrupt, "line" | "title" | "message">>(open: T[], line: number, message: string): T | undefined {
  return open.find((f) => f.line === line && diagnosticMessage(f) === message);
}

/** The quick fixes on an interrupt's squiggle. They run commands; none edits the code (I1). */
export function noteActions(f: Pick<Interrupt, "id" | "title">): { title: string; command: string; args: [string] }[] {
  return [
    { title: `Explain: ${f.title} (Assistive)`, command: "assistive.explainNote", args: [f.id] },
    { title: "Got it: dismiss this note (Assistive)", command: "assistive.dismissNote", args: [f.id] },
  ];
}

// ------------------------------------------------------------ planned files

/** The picker's description of a planned file: progress and the next piece. */
export function plannedFileDescription(graph: FileGraph): string {
  const p = progress(graph);
  return p.total ? `${p.done}/${p.total} done${p.next ? ` · next: ${nodeName(p.next)}` : ""}` : "";
}

// ------------------------------------------------------------ export

/** One line of readable Markdown: inline code and emphasis stay, HTML and line breaks do not. */
function inline(text: string): string {
  return text.replace(/\s+/g, " ").replace(/</g, "&lt;").trim();
}

/**
 * The graph as a Markdown document: the docstring, the progress, a Mermaid
 * chart and the steps in typing order as a checklist. It reads well outside
 * VS Code, for example in a pull request.
 */
export function graphMarkdown(graph: FileGraph): string {
  const out = [`# Implementation graph: ${graph.file}`, "", `> ${graph.moduleString.split("\n").join("\n> ")}`, ""];
  const p = progress(graph);
  if (p.total) {
    out.push(`Progress: ${p.done} of ${p.total} pieces typed${p.next ? `. Next: \`${nodeName(p.next)}\`.` : "."}`, "");
  }
  out.push(codeBlock(toMermaid(graph), "mermaid"), "");
  const steps = orderedNodes(graph).filter((n) => n.kind !== "module");
  if (steps.length) {
    out.push("## Steps", "");
    steps.forEach((n, i) => {
      const box = n.status === "done" ? "[x]" : "[ ]";
      const sig = n.signature ? ` · \`${n.signature.replace(/`/g, "'")}\`` : "";
      out.push(`${i + 1}. ${box} **${inline(n.label)}** (${n.kind})${sig}`);
      if (n.description) out.push(`   ${inline(n.description)}`);
      for (const note of n.notes) out.push(`   - ${inline(note)}`);
      if (n.attention) out.push(`   - ⚠ ${inline(n.attention)}`);
    });
    out.push("");
  }
  return out.join("\n");
}
