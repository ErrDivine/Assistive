// Pure Python-source helpers (no `vscode` import; unit-tested).

const PY_KEYWORDS = new Set(
  (
    "False None True and as assert async await break class continue def del elif else except " +
    "finally for from global if import in is lambda nonlocal not or pass raise return try " +
    "while with yield self cls"
  ).split(" "),
);

export function isKeyword(word: string): boolean {
  return PY_KEYWORDS.has(word);
}

/** Index of the line that closes a def/class header starting at ``i`` (its colon). */
function headerEnd(lines: string[], i: number): number {
  let depth = 0;
  for (let j = i; j < lines.length && j < i + 50; j++) {
    const code = stripStrings(lines[j]).split("#")[0];
    for (const ch of code) {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && code.trimEnd().endsWith(":")) {
      return j;
    }
  }
  return i;
}

/** Replace string literal contents with spaces (keeps columns stable). */
export function stripStrings(text: string): string {
  return text.replace(/(["'])(?:\\.|(?!\1).)*\1/g, (m) => m[0] + " ".repeat(m.length - 2) + m[0]);
}

/**
 * Indentation-based fallback when no symbol provider answers: the innermost
 * ``def``/``class`` whose block contains ``line``. Multi-line headers (Black's
 * ``):`` at the def's own indent) count as part of the def. Returns 0-based
 * inclusive lines.
 */
export function pythonEnclosingRange(lines: string[], line: number): [number, number] | undefined {
  const indent = (s: string) => s.length - s.trimStart().length;
  const isBlank = (s: string) => s.trim() === "" || s.trimStart().startsWith("#");
  const header = /^\s*(?:async\s+def|def|class)\s+[A-Za-z_]/;
  let cursorIndent = Infinity;
  for (let i = line; i >= 0; i--) {
    if (!isBlank(lines[i] ?? "")) {
      cursorIndent = indent(lines[i]);
      break;
    }
  }
  for (let i = line; i >= 0; i--) {
    const text = lines[i] ?? "";
    if (!header.test(text)) {
      continue;
    }
    const ind = indent(text);
    const hEnd = headerEnd(lines, i);
    const inHeader = line >= i && line <= hEnd;
    if (!inHeader && i !== line && ind >= cursorIndent) {
      continue;
    }
    // Decorators directly above belong to the def.
    let start = i;
    while (start > 0 && /^\s*@/.test(lines[start - 1])) {
      start--;
    }
    let end = hEnd;
    for (let j = hEnd + 1; j < lines.length; j++) {
      if (isBlank(lines[j])) {
        continue;
      }
      if (indent(lines[j]) <= ind) {
        break;
      }
      end = j;
    }
    if (end >= line) {
      return [start, end];
    }
    cursorIndent = ind;
  }
  return undefined;
}

/** Distinct identifiers on a line (minus keywords, literals and ``exclude``), with positions. */
export function lineIdentifiers(
  text: string,
  exclude: string | undefined,
  max = 5,
): { word: string; character: number }[] {
  const out: { word: string; character: number }[] = [];
  const seen = new Set<string>();
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  // Ignore string contents and comments.
  const code = stripStrings(text).split("#")[0];
  while ((m = re.exec(code)) && out.length < max) {
    const word = m[0];
    const prev = m.index > 0 ? code[m.index - 1] : "";
    if (/[0-9.]/.test(prev) && /[0-9]/.test(code.slice(0, m.index).replace(/\.$/, "").slice(-1))) {
      continue; // the letters of a numeric literal: 1e5, 0xFF, 10j, 3.5e-2
    }
    if (word === exclude || isKeyword(word) || seen.has(word)) {
      continue;
    }
    seen.add(word);
    out.push({ word, character: m.index });
  }
  return out;
}
