// File outline: the module string at the head of the file, the top-level and
// class-level symbols (with signatures, docstrings and stub detection), and the
// imports. Tree-sitter does the parsing; Python has a regex fallback.

import type { Node as TSNode } from "@vscode/tree-sitter-wasm";
import { goImports, goSymbols, javaImports, javaSymbols, rustImports, rustSymbols } from "./langs";
import { pythonEnclosingRange, stripStrings } from "./pyscope";
import { type Grammar, grammarFor, type TreeSitter } from "./treesitter";
import { cleandoc, firstLine, header, kids, normalizeSignature } from "./tsutil";

export { cleandoc, normalizeSignature };

export type SymbolKind = "class" | "function" | "method" | "constant" | "variable" | "type";

export interface OutlineSymbol {
  /** Name as written: `get`. */
  name: string;
  /** Dotted name inside the file: `Cache.get`. */
  qualname: string;
  kind: SymbolKind;
  /** 0-based, inclusive; `line` includes decorators. */
  line: number;
  endLine: number;
  /** Header up to the body, whitespace collapsed: `def get(self, key: str) -> bytes | None`. */
  signature: string;
  docstring?: string;
  /** Body is only a placeholder (pass / ... / NotImplementedError / empty block). */
  isStub: boolean;
  parent?: string;
}

export interface ModuleString {
  text: string;
  /** The docstring or comment is terminated, so the programmer has finished it. */
  closed: boolean;
  startLine: number;
  endLine: number;
}

export interface FileOutline {
  language: string;
  moduleString?: ModuleString;
  symbols: OutlineSymbol[];
  /** Imported module specifiers: `os.path`, `.cache`, `./util`, `react`. */
  imports: string[];
  parser: "tree-sitter" | "regex" | "none";
  /** The parse tree contains syntax errors. */
  hasErrors: boolean;
}

// ---------------------------------------------------------------- module string

function lineOf(text: string, offset: number): number {
  let n = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      n++;
    }
  }
  return n;
}

/** The module docstring: the first statement of the file when it is a string literal. */
export function pythonModuleString(text: string): ModuleString | undefined {
  const head = /^(?:[ \t]*(?:#[^\n]*)?\r?\n)*[ \t]*/.exec(text);
  const start = head ? head[0].length : 0;
  const m = /^[rRuU]{0,2}("""|'''|"|')/.exec(text.slice(start));
  if (!m) {
    return undefined;
  }
  const quote = m[1];
  const bodyStart = start + m[0].length;
  const startLine = lineOf(text, start);
  let end = -1;
  if (quote.length === 3) {
    end = text.indexOf(quote, bodyStart);
  } else {
    for (let i = bodyStart; i < text.length; i++) {
      const c = text[i];
      if (c === "\\") {
        i++;
      } else if (c === quote) {
        end = i;
        break;
      } else if (c === "\n") {
        break;
      }
    }
  }
  if (end < 0) {
    // Still being typed: everything up to the end of the file (or line) so far.
    const stop = quote.length === 3 ? text.length : (text.indexOf("\n", bodyStart) + 1 || text.length + 1) - 1;
    const raw = text.slice(bodyStart, stop);
    return { text: cleandoc(raw), closed: false, startLine, endLine: lineOf(text, stop) };
  }
  return { text: cleandoc(text.slice(bodyStart, end)), closed: true, startLine, endLine: lineOf(text, end) };
}

/** Lines before the module comment that are not part of it: shebang, "use strict", Go build tags. */
const PRELUDE = /^(\s*$|#!|\s*["']use strict["'];?\s*$|\/\/go:build\b|\/\/ \+build\b)/;

/**
 * The leading comment of a C-style file (JS/TS, Go, Rust, Java): a block
 * comment, or a run of `//` lines (Rust's `//!` included). A `//` run counts as
 * finished once code or an empty line followed by more text comes after it.
 */
export function cStyleModuleString(text: string): ModuleString | undefined {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && PRELUDE.test(lines[i])) {
    i++;
  }
  if (i >= lines.length) {
    return undefined;
  }
  const first = lines[i].trimStart();
  if (first.startsWith("/*")) {
    const offset = lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0) + (lines[i].length - first.length);
    const close = text.indexOf("*/", offset + 2);
    const raw = text.slice(offset + 2, close < 0 ? text.length : close).replace(/^[*!]+/, "");
    const body = raw
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*\*(?!\/) ?/, ""))
      .join("\n");
    return {
      text: cleandoc(body),
      closed: close >= 0,
      startLine: i,
      endLine: close < 0 ? lines.length - 1 : lineOf(text, close),
    };
  }
  if (first.startsWith("//")) {
    let j = i;
    const body: string[] = [];
    while (j < lines.length && lines[j].trimStart().startsWith("//")) {
      body.push(lines[j].trimStart().replace(/^\/\/+!? ?/, ""));
      j++;
    }
    const rest = lines.slice(j);
    // Code after the comment, or an empty line after it (two line breaks).
    const closed = rest.some((l) => l.trim() !== "") || rest.length >= 2;
    return { text: cleandoc(body.join("\n")), closed, startLine: i, endLine: j - 1 };
  }
  return undefined;
}

/** The JS/TS name of cStyleModuleString. */
export const jsModuleString = cStyleModuleString;

export function moduleStringOf(languageId: string, text: string): ModuleString | undefined {
  if (languageId === "python") {
    return pythonModuleString(text);
  }
  if (grammarFor(languageId)) {
    return cStyleModuleString(text);
  }
  return undefined;
}

// ---------------------------------------------------------------- helpers

function unquotePython(lit: string): string {
  const m = /^[rRuUbBfF]{0,2}("""|'''|"|')([\s\S]*?)\1$/.exec(lit.trim());
  return cleandoc(m ? m[2] : lit);
}

// ---------------------------------------------------------------- python

function pyDocstring(body: TSNode | null): string | undefined {
  const first = kids(body).find((n) => n.type !== "comment");
  if (first?.type === "expression_statement" && first.firstNamedChild?.type === "string") {
    return unquotePython(first.firstNamedChild.text);
  }
  return undefined;
}

function pyIsStub(body: TSNode | null): boolean {
  if (!body) {
    return true;
  }
  let stmts = kids(body).filter((n) => n.type !== "comment");
  if (stmts[0]?.type === "expression_statement" && stmts[0].firstNamedChild?.type === "string") {
    stmts = stmts.slice(1);
  }
  return stmts.every(
    (s) =>
      s.type === "pass_statement" ||
      (s.type === "expression_statement" && s.firstNamedChild?.type === "ellipsis") ||
      (s.type === "raise_statement" && /NotImplementedError/.test(s.text)),
  );
}

function pythonSymbols(root: TSNode): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  const visit = (block: TSNode, parent?: OutlineSymbol) => {
    for (const child of kids(block)) {
      const def = child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
      if (!def) {
        continue;
      }
      if (def.type === "function_definition" || def.type === "class_definition") {
        const name = def.childForFieldName("name")?.text;
        if (!name) {
          continue;
        }
        const body = def.childForFieldName("body");
        const isClass = def.type === "class_definition";
        const sym: OutlineSymbol = {
          name,
          qualname: parent ? `${parent.qualname}.${name}` : name,
          kind: isClass ? "class" : parent?.kind === "class" ? "method" : "function",
          line: child.startPosition.row,
          endLine: child.endPosition.row,
          signature: header(def, body),
          docstring: pyDocstring(body),
          isStub: pyIsStub(body),
          parent: parent?.qualname,
        };
        out.push(sym);
        if (isClass && body) {
          visit(body, sym);
        }
      } else if (!parent && child.type === "expression_statement") {
        const assign = child.firstNamedChild;
        const left = assign?.type === "assignment" ? assign.childForFieldName("left") : null;
        if (left?.type === "identifier" && !/^__\w+__$/.test(left.text)) {
          out.push({
            name: left.text,
            qualname: left.text,
            kind: /^[A-Z][A-Z0-9_]*$/.test(left.text) ? "constant" : "variable",
            line: child.startPosition.row,
            endLine: child.endPosition.row,
            signature: firstLine(child.text),
            isStub: false,
          });
        }
      }
    }
  };
  visit(root);
  return out;
}

function pythonImports(root: TSNode): string[] {
  const out: string[] = [];
  for (const n of kids(root)) {
    if (n.type === "import_statement") {
      for (const name of n.childrenForFieldName("name")) {
        const dotted = name?.type === "aliased_import" ? name.childForFieldName("name") : name;
        if (dotted) {
          out.push(dotted.text);
        }
      }
    } else if (n.type === "import_from_statement") {
      const mod = n.childForFieldName("module_name");
      if (mod) {
        out.push(mod.text);
      }
    } else if (n.type === "future_import_statement") {
      out.push("__future__");
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- js / ts

function jsDoc(node: TSNode, minRow: number): string | undefined {
  const prev = node.previousSibling;
  if (prev?.type === "comment" && prev.text.startsWith("/**") && prev.endPosition.row >= node.startPosition.row - 1) {
    if (prev.startPosition.row <= minRow) {
      return undefined; // that comment is the module string
    }
    return cleandoc(
      prev.text
        .replace(/^\/\*\*+/, "")
        .replace(/\*\/$/, "")
        .split("\n")
        .map((l) => l.replace(/^\s*\* ?/, ""))
        .join("\n"),
    );
  }
  return undefined;
}

function jsIsStub(body: TSNode | null): boolean {
  if (!body) {
    return true;
  }
  if (body.type !== "statement_block") {
    return false;
  }
  const stmts = kids(body).filter((n) => n.type !== "comment");
  return stmts.every((s) => s.type === "throw_statement" && /not\s*(yet\s*)?implemented|unimplemented|todo/i.test(s.text));
}

const JS_FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);

function jsSymbols(root: TSNode, moduleEnd: number): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  const push = (sym: OutlineSymbol) => out.push(sym);

  const classMembers = (body: TSNode, cls: OutlineSymbol) => {
    for (const m of kids(body)) {
      let fn: TSNode | null = null;
      if (m.type === "method_definition" || m.type === "abstract_method_signature" || m.type === "method_signature") {
        fn = m;
      } else if (m.type === "public_field_definition") {
        const value = m.childForFieldName("value");
        if (value && JS_FUNCTION_VALUES.has(value.type)) {
          fn = m;
        }
      }
      const name = fn?.childForFieldName("name")?.text;
      if (!fn || !name) {
        continue;
      }
      const body =
        m.type === "public_field_definition"
          ? (m.childForFieldName("value")?.childForFieldName("body") ?? null)
          : m.childForFieldName("body");
      push({
        name,
        qualname: `${cls.qualname}.${name}`,
        kind: "method",
        line: m.startPosition.row,
        endLine: m.endPosition.row,
        signature: header(m, body),
        docstring: jsDoc(m, moduleEnd),
        isStub: m.type.endsWith("signature") ? false : jsIsStub(body),
        parent: cls.qualname,
      });
    }
  };

  for (const top of kids(root)) {
    let decl: TSNode | null = top;
    if (top.type === "export_statement") {
      decl = top.childForFieldName("declaration");
    }
    if (!decl) {
      continue;
    }
    const doc = jsDoc(top, moduleEnd);
    const line = top.startPosition.row;
    const endLine = top.endPosition.row;
    switch (decl.type) {
      case "function_declaration":
      case "generator_function_declaration":
      case "function_signature": {
        const name = decl.childForFieldName("name")?.text;
        const body = decl.childForFieldName("body");
        if (name) {
          push({
            name,
            qualname: name,
            kind: "function",
            line,
            endLine,
            signature: header(decl, body),
            docstring: doc,
            isStub: decl.type === "function_signature" ? false : jsIsStub(body),
          });
        }
        break;
      }
      case "class_declaration":
      case "abstract_class_declaration": {
        const name = decl.childForFieldName("name")?.text;
        const body = decl.childForFieldName("body");
        if (name) {
          const cls: OutlineSymbol = {
            name,
            qualname: name,
            kind: "class",
            line,
            endLine,
            signature: header(decl, body),
            docstring: doc,
            isStub: kids(body).length === 0,
          };
          push(cls);
          if (body) {
            classMembers(body, cls);
          }
        }
        break;
      }
      case "lexical_declaration":
      case "variable_declaration": {
        for (const d of kids(decl).filter((n) => n.type === "variable_declarator")) {
          const nameNode = d.childForFieldName("name");
          if (nameNode?.type !== "identifier") {
            continue;
          }
          const name = nameNode.text;
          const value = d.childForFieldName("value");
          if (value && JS_FUNCTION_VALUES.has(value.type)) {
            const body = value.childForFieldName("body");
            push({
              name,
              qualname: name,
              kind: "function",
              line,
              endLine,
              signature: header(top.type === "export_statement" ? top : decl, body),
              docstring: doc,
              isStub: jsIsStub(body),
            });
          } else {
            push({
              name,
              qualname: name,
              kind: /^[A-Z][A-Z0-9_]*$/.test(name) ? "constant" : "variable",
              line,
              endLine,
              signature: firstLine(top.text),
              docstring: doc,
              isStub: false,
            });
          }
        }
        break;
      }
      case "interface_declaration":
      case "type_alias_declaration":
      case "enum_declaration": {
        const name = decl.childForFieldName("name")?.text;
        if (name) {
          push({ name, qualname: name, kind: "type", line, endLine, signature: firstLine(top.text), docstring: doc, isStub: false });
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function jsImports(root: TSNode): string[] {
  const out: string[] = [];
  for (const n of kids(root)) {
    if (n.type === "import_statement" || n.type === "export_statement") {
      const src = n.childForFieldName("source");
      if (src) {
        out.push(src.text.replace(/^["'`]|["'`]$/g, ""));
      }
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- regex fallback

/** Indentation-based Python outline for when tree-sitter is unavailable. */
export function pythonOutlineRegex(text: string): OutlineSymbol[] {
  const lines = text.split(/\r?\n/);
  const out: OutlineSymbol[] = [];
  const stack: { indent: number; sym: OutlineSymbol }[] = [];
  const re = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) {
      const c = /^([A-Z][A-Z0-9_]*)\s*(?::[^=]*)?=(?!=)/.exec(lines[i]);
      if (c) {
        out.push({ name: c[1], qualname: c[1], kind: "constant", line: i, endLine: i, signature: firstLine(lines[i]), isStub: false });
      }
      continue;
    }
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]?.sym;
    if (parent && parent.kind !== "class") {
      continue; // nested function
    }
    const range = pythonEnclosingRange(lines, i) ?? [i, i];
    let hEnd = i;
    while (hEnd < range[1] && !stripStrings(lines[hEnd]).split("#")[0].trimEnd().endsWith(":")) {
      hEnd++;
    }
    const bodyLines = lines.slice(hEnd + 1, range[1] + 1).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    let docstring: string | undefined;
    if (/^[rRuU]?("""|''')/.test(bodyLines[0] ?? "")) {
      const q = bodyLines[0].replace(/^[rRuU]?/, "").slice(0, 3);
      const joined = bodyLines.join("\n");
      const start = joined.indexOf(q) + 3;
      const end = joined.indexOf(q, start);
      docstring = cleandoc(joined.slice(start, end < 0 ? undefined : end));
      const used = joined.slice(0, end < 0 ? joined.length : end + 3).split("\n").length;
      bodyLines.splice(0, used);
    }
    const sym: OutlineSymbol = {
      name: m[3],
      qualname: parent ? `${parent.qualname}.${m[3]}` : m[3],
      kind: m[2] === "class" ? "class" : parent ? "method" : "function",
      line: range[0],
      endLine: range[1],
      signature: normalizeSignature(
        lines
          .slice(i, hEnd + 1)
          .map((l) => l.replace(/\s+#.*$/, ""))
          .join(" "),
      ),
      docstring,
      isStub: bodyLines.every((l) => /^(pass|\.\.\.|raise\s+NotImplementedError\b.*)$/.test(l)),
      parent: parent?.qualname,
    };
    out.push(sym);
    stack.push({ indent, sym });
  }
  return out;
}

function pythonImportsRegex(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let m = /^from\s+(\S+)\s+import\b/.exec(line);
    if (m) {
      out.push(m[1]);
      continue;
    }
    m = /^import\s+(.+)$/.exec(line);
    if (m) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+/)[0];
        if (name) {
          out.push(name);
        }
      }
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- entry points

export async function outline(ts: TreeSitter | undefined, languageId: string, text: string): Promise<FileOutline> {
  const moduleString = moduleStringOf(languageId, text);
  const grammar: Grammar | undefined = grammarFor(languageId);
  if (ts && grammar) {
    try {
      const tree = await ts.parse(grammar, text);
      if (tree) {
        try {
          const root = tree.rootNode;
          const end = moduleString?.endLine ?? -1;
          const [symbols, imports] = extract(grammar, root, end);
          return { language: languageId, moduleString, symbols, imports, parser: "tree-sitter", hasErrors: root.hasError };
        } finally {
          tree.delete();
        }
      }
    } catch {
      // fall through to the regex outline
    }
  }
  if (languageId === "python") {
    return {
      language: languageId,
      moduleString,
      symbols: pythonOutlineRegex(text),
      imports: pythonImportsRegex(text),
      parser: "regex",
      hasErrors: false,
    };
  }
  return { language: languageId, moduleString, symbols: [], imports: [], parser: "none", hasErrors: false };
}

function extract(grammar: Grammar, root: TSNode, moduleEnd: number): [OutlineSymbol[], string[]] {
  switch (grammar) {
    case "python":
      return [pythonSymbols(root), pythonImports(root)];
    case "go":
      return [goSymbols(root, moduleEnd), goImports(root)];
    case "rust":
      return [rustSymbols(root, moduleEnd), rustImports(root)];
    case "java":
      return [javaSymbols(root, moduleEnd), javaImports(root)];
    default:
      return [jsSymbols(root, moduleEnd), jsImports(root)];
  }
}

/** Innermost symbol whose range contains `line` (0-based). */
export function symbolAt(o: FileOutline, line: number): OutlineSymbol | undefined {
  let best: OutlineSymbol | undefined;
  for (const s of o.symbols) {
    if (s.line <= line && line <= s.endLine && (!best || s.endLine - s.line <= best.endLine - best.line)) {
      best = s;
    }
  }
  return best;
}

/** Compact text for prompts: one line per symbol, 1-based line numbers. */
export function formatOutline(o: FileOutline, opts: { docstrings?: boolean } = {}): string {
  const lines: string[] = [];
  if (o.imports.length) {
    lines.push(`imports: ${o.imports.join(", ")}`);
  }
  for (const s of o.symbols) {
    const indent = s.parent ? "  " : "";
    const flags = s.isStub ? "  [stub]" : "";
    lines.push(`${indent}L${s.line + 1}-${s.endLine + 1} ${s.signature}${flags}`);
    if (opts.docstrings && s.docstring) {
      lines.push(`${indent}    "${firstLine(s.docstring, 140)}"`);
    }
  }
  if (!o.symbols.length) {
    lines.push("(no symbols yet)");
  }
  if (o.hasErrors) {
    lines.push("(the file currently has syntax errors)");
  }
  return lines.join("\n");
}
