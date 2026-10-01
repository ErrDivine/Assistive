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

/**
 * Indentation-based fallback when no symbol provider answers: the innermost
 * ``def``/``class`` whose block contains ``line``. Returns 0-based inclusive lines.
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
    if (i !== line && ind >= cursorIndent) {
      continue;
    }
    // Decorators directly above belong to the def.
    let start = i;
    while (start > 0 && /^\s*@/.test(lines[start - 1])) {
      start--;
    }
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
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

/** Distinct identifiers on a line (minus keywords and ``exclude``), with positions. */
export function lineIdentifiers(
  text: string,
  exclude: string | undefined,
  max = 5,
): { word: string; character: number }[] {
  const out: { word: string; character: number }[] = [];
  const seen = new Set<string>();
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  // Skip string literals and comments roughly: stop at '#'.
  const code = text.split("#")[0];
  while ((m = re.exec(code)) && out.length < max) {
    const word = m[0];
    if (word === exclude || isKeyword(word) || seen.has(word) || /^\d/.test(word)) {
      continue;
    }
    seen.add(word);
    out.push({ word, character: m.index });
  }
  return out;
}
