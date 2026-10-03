// Small helpers over tree-sitter nodes and source text, shared by the
// outline extractors of every language. Pure.

import type { Node as TSNode } from "@vscode/tree-sitter-wasm";

export const MAX_SIGNATURE = 300;

/** PEP 257 `inspect.cleandoc`: strip the first line, dedent the rest, trim blank edges. */
export function cleandoc(raw: string): string {
  const lines = raw.replace(/\t/g, "    ").split(/\r?\n/);
  let margin = Infinity;
  for (const l of lines.slice(1)) {
    const content = l.trimStart();
    if (content) {
      margin = Math.min(margin, l.length - content.length);
    }
  }
  const out = [lines[0].trim(), ...lines.slice(1).map((l) => (margin === Infinity ? l.trim() : l.slice(margin).trimEnd()))];
  while (out.length && !out[0]) {
    out.shift();
  }
  while (out.length && !out[out.length - 1]) {
    out.pop();
  }
  return out.join("\n");
}

export function kids(node: TSNode | null | undefined): TSNode[] {
  return (node?.namedChildren ?? []).filter((n): n is TSNode => !!n);
}

/** Comment nodes are named differently per grammar: comment, line_comment, block_comment. */
export function isComment(node: TSNode | null | undefined): boolean {
  return !!node && /comment/.test(node.type);
}

/** Collapse a (possibly multi-line) header to one line without the trailing `:` / `=>` / `{`. */
export function normalizeSignature(raw: string): string {
  const sig = raw
    .replace(/\s+/g, " ")
    .replace(/([([{])\s+/g, "$1")
    .replace(/,?\s+([)\]}])/g, "$1")
    .trim()
    .replace(/\s*(:|=>|\{)\s*$/, "");
  return sig.length > MAX_SIGNATURE ? sig.slice(0, MAX_SIGNATURE - 1) + "…" : sig;
}

/** The declaration's text up to its body, as one line, without comments. */
export function header(def: TSNode, body: TSNode | null): string {
  let raw = body ? def.text.slice(0, body.startIndex - def.startIndex) : def.text.split("\n")[0];
  // Comments between the parameters and the body are not part of the signature.
  for (const c of def.children) {
    if (c && isComment(c) && (!body || c.startIndex < body.startIndex)) {
      raw = raw.replace(c.text, " ");
    }
  }
  return normalizeSignature(raw);
}

export function firstLine(text: string, max = 160): string {
  const l = text.split("\n")[0].trim();
  return l.length > max ? l.slice(0, max - 1) + "…" : l;
}

/** Text of a comment without its markers: `/** … *\/`, `///`, `//!`, `//`, leading `*`. */
export function commentText(raw: string): string {
  if (/^\/\*/.test(raw)) {
    return cleandoc(
      raw
        .replace(/^\/\*[*!]*/, "")
        .replace(/\*\/$/, "")
        .split("\n")
        .map((l) => l.replace(/^\s*\*(?!\/) ?/, ""))
        .join("\n"),
    );
  }
  return cleandoc(
    raw
      .split("\n")
      .map((l) => l.trim().replace(/^\/\/+!? ?/, ""))
      .join("\n"),
  );
}

/**
 * The doc comment right above a declaration: a run of comments whose last one
 * ends on the line before `node` (or the same line). Comments that start at or
 * before `minRow` belong to the module docstring and are ignored.
 */
export function precedingDoc(node: TSNode, minRow: number): string | undefined {
  const run: TSNode[] = [];
  let next = node.startPosition.row;
  for (let prev = node.previousNamedSibling; prev && isComment(prev); prev = prev.previousNamedSibling) {
    if (prev.endPosition.row < next - 1) {
      break;
    }
    run.unshift(prev);
    next = prev.startPosition.row;
  }
  if (!run.length || run[0].startPosition.row <= minRow) {
    return undefined;
  }
  const text = run.map((c) => commentText(c.text)).join("\n");
  return text.trim() ? cleandoc(text) : undefined;
}
