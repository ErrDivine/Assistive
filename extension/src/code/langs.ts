// Outline extractors for Go, Rust and Java: top-level and member symbols with
// signatures, doc comments and stub detection, and the imports. Python and
// JavaScript/TypeScript live in outline.ts. Pure.

import type { Node as TSNode } from "@vscode/tree-sitter-wasm";
import type { OutlineSymbol } from "./outline";
import { firstLine, header, isComment, kids, precedingDoc } from "./tsutil";

const NOT_IMPLEMENTED = /not\s*(yet\s*)?implemented|unimplemented|todo/i;

/** Statements of a block, without comments (Go nests them in a statement_list). */
function statements(body: TSNode | null): TSNode[] {
  return kids(body)
    .flatMap((n) => (n.type === "statement_list" ? kids(n) : [n]))
    .filter((n) => !isComment(n));
}

function span(node: TSNode): { line: number; endLine: number } {
  return { line: node.startPosition.row, endLine: node.endPosition.row };
}

// ---------------------------------------------------------------- go

/** Empty, or only `panic("not implemented")`-like calls. */
function goIsStub(body: TSNode | null): boolean {
  if (!body) {
    return false; // a declaration without a body (assembly, or an interface method)
  }
  return statements(body).every((s) => s.type === "expression_statement" && /^panic\s*\(/.test(s.text) && NOT_IMPLEMENTED.test(s.text));
}

/** `(c *Cache)` → `Cache`; `(s Stack[T])` → `Stack`. */
function goReceiverType(receiver: TSNode | null): string | undefined {
  return receiver ? /([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*\)\s*$/.exec(receiver.text)?.[1] : undefined;
}

export function goSymbols(root: TSNode, moduleEnd: number): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  for (const top of kids(root)) {
    const doc = precedingDoc(top, moduleEnd);
    switch (top.type) {
      case "function_declaration": {
        const name = top.childForFieldName("name")?.text;
        const body = top.childForFieldName("body");
        if (name) {
          out.push({ name, qualname: name, kind: "function", ...span(top), signature: header(top, body), docstring: doc, isStub: goIsStub(body) });
        }
        break;
      }
      case "method_declaration": {
        const name = top.childForFieldName("name")?.text;
        const recv = goReceiverType(top.childForFieldName("receiver"));
        const body = top.childForFieldName("body");
        if (name) {
          out.push({
            name,
            qualname: recv ? `${recv}.${name}` : name,
            kind: recv ? "method" : "function",
            ...span(top),
            signature: header(top, body),
            docstring: doc,
            isStub: goIsStub(body),
            parent: recv,
          });
        }
        break;
      }
      case "type_declaration": {
        const specs = kids(top).filter((n) => n.type === "type_spec" || n.type === "type_alias");
        for (const spec of specs) {
          const name = spec.childForFieldName("name")?.text;
          const type = spec.childForFieldName("type");
          if (name) {
            const where = specs.length > 1 ? spec : top;
            out.push({
              name,
              qualname: name,
              kind: type?.type === "struct_type" ? "class" : "type",
              ...span(where),
              signature: firstLine(specs.length > 1 ? `type ${spec.text}` : top.text).replace(/\s*\{$/, ""),
              docstring: doc,
              isStub: false,
            });
          }
        }
        break;
      }
      case "const_declaration":
      case "var_declaration": {
        for (const spec of kids(top).filter((n) => n.type === "const_spec" || n.type === "var_spec")) {
          for (const id of spec.childrenForFieldName("name")) {
            if (id?.text && id.text !== "_") {
              out.push({
                name: id.text,
                qualname: id.text,
                kind: top.type === "const_declaration" ? "constant" : "variable",
                ...span(spec),
                signature: `${top.type === "const_declaration" ? "const" : "var"} ${firstLine(spec.text)}`,
                docstring: doc,
                isStub: false,
              });
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export function goImports(root: TSNode): string[] {
  const out: string[] = [];
  const visit = (n: TSNode) => {
    if (n.type === "import_spec") {
      const p = n.childForFieldName("path")?.text;
      if (p) out.push(p.replace(/^["`]|["`]$/g, ""));
      return;
    }
    for (const c of kids(n)) visit(c);
  };
  for (const n of kids(root).filter((x) => x.type === "import_declaration")) {
    visit(n);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- rust

/** Empty, or only `todo!()`, `unimplemented!()` or `panic!("not implemented")`. */
function rustIsStub(body: TSNode | null): boolean {
  if (!body) {
    return false;
  }
  return statements(body).every((s) => {
    const m = s.type === "expression_statement" ? s.firstNamedChild : s;
    if (m?.type !== "macro_invocation") return false;
    const name = m.childForFieldName("macro")?.text ?? m.firstNamedChild?.text ?? "";
    return name === "todo" || name === "unimplemented" || (name === "panic" && NOT_IMPLEMENTED.test(m.text));
  });
}

/** `Cache<T>` → `Cache`; `&mut Cache` → `Cache`. */
function rustTypeName(node: TSNode | null): string | undefined {
  return node ? /([A-Za-z_]\w*)\s*(<.*>)?\s*$/.exec(node.text.replace(/^[&\s]*(mut\s+)?/, ""))?.[1] : undefined;
}

export function rustSymbols(root: TSNode, moduleEnd: number): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  const fn = (item: TSNode, doc: string | undefined, prefix: string | undefined, kind: "function" | "method") => {
    const name = item.childForFieldName("name")?.text;
    const body = item.childForFieldName("body");
    if (!name) return;
    out.push({
      name,
      qualname: prefix ? `${prefix}.${name}` : name,
      kind,
      ...span(item),
      signature: header(item, body).replace(/;$/, ""),
      docstring: doc,
      isStub: item.type === "function_signature_item" ? false : rustIsStub(body),
      parent: kind === "method" ? prefix : undefined,
    });
  };
  const visit = (block: TSNode, mod: string | undefined) => {
    for (const item of kids(block)) {
      const doc = precedingDoc(item, moduleEnd);
      const qual = (name: string) => (mod ? `${mod}.${name}` : name);
      switch (item.type) {
        case "function_item":
          fn(item, doc, mod, "function");
          break;
        case "struct_item":
        case "enum_item":
        case "trait_item":
        case "type_item":
        case "union_item": {
          const name = item.childForFieldName("name")?.text;
          if (!name) break;
          const body = item.childForFieldName("body");
          out.push({
            name,
            qualname: qual(name),
            kind: item.type === "struct_item" ? "class" : "type",
            ...span(item),
            signature: header(item, body).replace(/;$/, ""),
            docstring: doc,
            isStub: false,
          });
          if (item.type === "trait_item" && body) {
            for (const m of kids(body)) {
              if (m.type === "function_item" || m.type === "function_signature_item") fn(m, precedingDoc(m, moduleEnd), qual(name), "method");
            }
          }
          break;
        }
        case "const_item":
        case "static_item": {
          const name = item.childForFieldName("name")?.text;
          if (name) {
            out.push({ name, qualname: qual(name), kind: "constant", ...span(item), signature: firstLine(item.text), docstring: doc, isStub: false });
          }
          break;
        }
        case "impl_item": {
          const type = rustTypeName(item.childForFieldName("type"));
          const body = item.childForFieldName("body");
          if (!type || !body) break;
          for (const m of kids(body)) {
            if (m.type === "function_item") fn(m, precedingDoc(m, moduleEnd), qual(type), "method");
          }
          break;
        }
        case "mod_item": {
          const name = item.childForFieldName("name")?.text;
          const body = item.childForFieldName("body");
          if (name && body) visit(body, qual(name));
          break;
        }
        default:
          break;
      }
    }
  };
  visit(root, undefined);
  return out;
}

export function rustImports(root: TSNode): string[] {
  const out = kids(root)
    .filter((n) => n.type === "use_declaration")
    .map((n) => n.childForFieldName("argument")?.text ?? "")
    .filter(Boolean);
  return [...new Set(out)];
}

// ---------------------------------------------------------------- java

/** Empty, or only `throw new UnsupportedOperationException(…)` / "not implemented" throws. */
function javaIsStub(body: TSNode | null): boolean {
  if (!body) {
    return false; // abstract or interface method
  }
  return statements(body).every((s) => s.type === "throw_statement" && (/UnsupportedOperationException/.test(s.text) || NOT_IMPLEMENTED.test(s.text)));
}

const JAVA_TYPES = new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"]);

export function javaSymbols(root: TSNode, moduleEnd: number): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  const typeDecl = (decl: TSNode, parent: string | undefined) => {
    const name = decl.childForFieldName("name")?.text;
    const body = decl.childForFieldName("body");
    if (!name) return;
    const qualname = parent ? `${parent}.${name}` : name;
    const members = kids(body).flatMap((m) => (m.type === "enum_body_declarations" ? kids(m) : [m]));
    out.push({
      name,
      qualname,
      kind: decl.type === "class_declaration" || decl.type === "record_declaration" ? "class" : "type",
      ...span(decl),
      signature: header(decl, body),
      docstring: precedingDoc(decl, moduleEnd),
      isStub: decl.type === "class_declaration" && members.filter((m) => !isComment(m)).length === 0,
      parent,
    });
    for (const m of members) {
      if (JAVA_TYPES.has(m.type)) {
        typeDecl(m, qualname);
      } else if (m.type === "method_declaration" || m.type === "constructor_declaration") {
        const mname = m.childForFieldName("name")?.text;
        const mbody = m.childForFieldName("body");
        if (mname) {
          out.push({
            name: mname,
            qualname: `${qualname}.${mname}`,
            kind: "method",
            ...span(m),
            signature: header(m, mbody).replace(/;$/, ""),
            docstring: precedingDoc(m, moduleEnd),
            isStub: javaIsStub(mbody),
            parent: qualname,
          });
        }
      } else if (m.type === "field_declaration" || m.type === "constant_declaration") {
        const mods = kids(m).find((c) => c.type === "modifiers")?.text ?? "";
        const isConst = m.type === "constant_declaration" || (/\bstatic\b/.test(mods) && /\bfinal\b/.test(mods));
        if (!isConst) continue;
        for (const d of m.childrenForFieldName("declarator")) {
          const fname = d?.childForFieldName("name")?.text;
          if (fname) {
            out.push({
              name: fname,
              qualname: `${qualname}.${fname}`,
              kind: "constant",
              ...span(m),
              signature: firstLine(m.text),
              docstring: precedingDoc(m, moduleEnd),
              isStub: false,
              parent: qualname,
            });
          }
        }
      }
    }
  };
  for (const top of kids(root)) {
    if (JAVA_TYPES.has(top.type)) typeDecl(top, undefined);
  }
  return out;
}

export function javaImports(root: TSNode): string[] {
  const out = kids(root)
    .filter((n) => n.type === "import_declaration")
    .map((n) =>
      n.text
        .replace(/^import\s+(static\s+)?/, "")
        .replace(/\s*;\s*$/, "")
        .replace(/\s+/g, ""),
    );
  return [...new Set(out)];
}
