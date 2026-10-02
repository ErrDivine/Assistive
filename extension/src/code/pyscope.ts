// Pure Python-source helpers for the regex outline fallback (no `vscode` import).

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
