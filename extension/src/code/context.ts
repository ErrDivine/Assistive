// Project context for the LLM: a workspace abstraction (implemented with the
// VS Code API in workspace.ts, with plain fs in tests), and the helpers behind
// the read-only tools and the draft prompt's project summary.

import * as path from "node:path";
import { type FileOutline, formatOutline } from "./outline";

export interface SearchHit {
  path: string;
  /** 0-based. */
  line: number;
  text: string;
}

export interface DiagnosticInfo {
  path: string;
  /** 0-based. */
  line: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
}

export interface WorkspaceAccess {
  /** Absolute root folder. */
  readonly root: string;
  /** Workspace-relative paths (forward slashes), sorted, excluding vendored and build folders. */
  list(glob?: string, max?: number): Promise<string[]>;
  /** File text: the open editor buffer when there is one (unsaved edits included), else disk. */
  read(rel: string): Promise<string | undefined>;
  search(query: string, opts: { regex: boolean; glob?: string; max: number }): Promise<SearchHit[]>;
  diagnostics(rel?: string): DiagnosticInfo[];
  /** VS Code language id for a path, by extension. */
  languageOf(rel: string): string | undefined;
}

export const EXCLUDED_DIRS = [
  "node_modules",
  ".git",
  ".hg",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  "site-packages",
  ".idea",
  ".vscode-test",
];

export const EXCLUDE_GLOB = `**/{${EXCLUDED_DIRS.join(",")}}/**`;

const SECRET = /(^|\/)(\.env(?!\.(example|sample|template)$)(\..*)?|.*\.(pem|key|p12|pfx|keystore)|id_(rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc|\.netrc|credentials(\.\w+)?|secrets?\.(json|ya?ml|toml))$/i;

/**
 * A model-written regular expression that can backtrack catastrophically: a
 * quantified group that itself contains a quantifier, e.g. `(a+)+` or `(\w*)*`.
 * JavaScript regexes run on the extension host's only thread, so these are refused.
 */
export function riskyRegex(pattern: string): boolean {
  return /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d*,)/.test(pattern);
}

/** Search limits that keep a search from blocking the editor. */
export const SEARCH_LINE_CHARS = 1000;
export const SEARCH_BUDGET_MS = 1500;

/** Files the tools refuse to read: keys, credentials, .env files. */
export function isSecretPath(rel: string): boolean {
  return SECRET.test(rel.replace(/\\/g, "/"));
}

/** Normalize a model-supplied path to a workspace-relative one; undefined if it escapes the root. */
export function normalizeRel(root: string, p: string): string | undefined {
  const cleaned = p.trim().replace(/\\/g, "/");
  let abs = path.isAbsolute(cleaned) ? cleaned : path.resolve(root, cleaned);
  const escapes = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (path.isAbsolute(cleaned) && escapes(path.relative(root, abs))) {
    abs = path.resolve(root, cleaned.replace(/^\/+/, "")); // "/app/x.py" meant relative to the root
  }
  const rel = path.relative(root, abs);
  if (escapes(rel)) {
    return undefined;
  }
  return rel.split(path.sep).join("/");
}

/** `  12| text` with 1-based numbers. */
export function numberLines(text: string, start = 1, end?: number): string {
  const lines = text.split(/\r?\n/);
  const last = Math.min(lines.length, end ?? lines.length);
  const width = String(last).length;
  const out: string[] = [];
  for (let i = Math.max(1, start); i <= last; i++) {
    out.push(`${String(i).padStart(width)}| ${lines[i - 1]}`);
  }
  return out.join("\n");
}

/** Compact indented tree of paths. */
export function fileTree(paths: string[], max = 150): string {
  const shown = paths.slice(0, max);
  const out: string[] = [];
  let prev: string[] = [];
  for (const p of shown) {
    const parts = p.split("/");
    const dirs = parts.slice(0, -1);
    let common = 0;
    while (common < dirs.length && common < prev.length && dirs[common] === prev[common]) {
      common++;
    }
    for (let i = common; i < dirs.length; i++) {
      out.push(`${"  ".repeat(i)}${dirs[i]}/`);
    }
    out.push(`${"  ".repeat(dirs.length)}${parts[parts.length - 1]}`);
    prev = dirs;
  }
  if (paths.length > max) {
    out.push(`… and ${paths.length - max} more files`);
  }
  return out.join("\n");
}

/** Candidate workspace files for an import specifier seen in `fromFile`. */
export function resolveImport(spec: string, fromFile: string, language: string, files: Set<string>): string | undefined {
  const dir = path.posix.dirname(fromFile);
  const first = (cands: string[]) => cands.map((c) => path.posix.normalize(c)).find((c) => files.has(c));
  if (language === "python") {
    const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
    const mod = spec.slice(dots).split(".").filter(Boolean).join("/");
    let bases: string[];
    if (dots) {
      let base = dir;
      for (let i = 1; i < dots; i++) {
        base = path.posix.dirname(base);
      }
      bases = [base];
    } else {
      // Absolute import: the repo root, src/, or the package the file lives in.
      bases = [".", "src", ...ancestors(dir)];
    }
    for (const b of bases) {
      // `from . import x` names the package itself: its __init__.py.
      const hit = mod ? first([`${path.posix.join(b, mod)}.py`, `${path.posix.join(b, mod)}/__init__.py`]) : first([`${b}/__init__.py`]);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }
  if (language === "go") {
    return resolveGoImport(spec, files);
  }
  if (language === "rust") {
    return resolveRustUse(spec, fromFile, files);
  }
  if (language === "java") {
    return resolveJavaImport(spec, files);
  }
  if (!spec.startsWith(".")) {
    return undefined; // a package
  }
  const stem = path.posix.join(dir, spec);
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
  return first([stem, ...exts.map((e) => stem + e), ...exts.map((e) => `${stem}/index${e}`), stem.replace(/\.js$/, ".ts")]);
}

/** A Go import of this module (`example.com/app/internal/cache`): the first file of the package folder. */
function resolveGoImport(spec: string, files: Set<string>): string | undefined {
  const segs = spec.split("/");
  if (!segs[0].includes(".")) {
    return undefined; // the standard library
  }
  const sorted = [...files].sort();
  for (let k = 1; k < segs.length; k++) {
    const dir = segs.slice(k).join("/");
    const hit = sorted.find((f) => path.posix.dirname(f) === dir && f.endsWith(".go") && !f.endsWith("_test.go"));
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/** A Rust `use crate::a::b::C` / `self::…` / `super::…`: the file of the deepest module that exists. */
function resolveRustUse(spec: string, fromFile: string, files: Set<string>): string | undefined {
  const segs = spec.replace(/::\{.*$/s, "").replace(/\s+as\s+\w+$/, "").split("::");
  const dir = path.posix.dirname(fromFile);
  const stem = path.posix.basename(fromFile, ".rs");
  const ownsDir = ["mod", "lib", "main"].includes(stem);
  const moduleDir = ownsDir ? dir : path.posix.join(dir, stem);
  let base: string;
  if (segs[0] === "crate") {
    const at = fromFile.lastIndexOf("src/");
    base = at >= 0 ? fromFile.slice(0, at + 3) : dir;
  } else if (segs[0] === "self") {
    base = moduleDir;
  } else if (segs[0] === "super") {
    base = path.posix.dirname(moduleDir);
  } else {
    return undefined; // another crate
  }
  const rest = segs.slice(1);
  for (let k = rest.length; k >= 1; k--) {
    const p = path.posix.join(base, ...rest.slice(0, k));
    const hit = [`${p}.rs`, `${p}/mod.rs`].find((c) => files.has(c));
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/** A Java import (`com.example.util.Strings`, static members and `.*` included): the source file under any source root. */
function resolveJavaImport(spec: string, files: Set<string>): string | undefined {
  const wildcard = spec.endsWith(".*");
  const segs = spec.replace(/\.\*$/, "").split(".");
  const sorted = [...files].sort();
  const find = (rel: string) => sorted.find((f) => f === rel || f.endsWith(`/${rel}`));
  if (wildcard) {
    const pkg = segs.join("/");
    const hit = sorted.find((f) => f.endsWith(".java") && (path.posix.dirname(f) === pkg || path.posix.dirname(f).endsWith(`/${pkg}`)));
    if (hit) {
      return hit;
    }
  }
  for (let k = segs.length; k >= 2; k--) {
    const hit = find(`${segs.slice(0, k).join("/")}.java`);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

function ancestors(dir: string): string[] {
  const out: string[] = [];
  let d = dir;
  while (d && d !== ".") {
    d = path.posix.dirname(d);
    out.push(d);
  }
  return out;
}

const MANIFESTS = [
  "pyproject.toml",
  "requirements.txt",
  "setup.cfg",
  "setup.py",
  "package.json",
  "tsconfig.json",
  "environment.yml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
];

/** Project context included in draft and sync prompts. */
export async function projectSummary(
  ws: WorkspaceAccess,
  file: string,
  current: FileOutline,
  outlineOf: (rel: string, text: string) => Promise<FileOutline>,
  /** Signatures planned in another file's graph that are not typed yet. */
  plannedOf?: (rel: string) => string[],
): Promise<string> {
  const files = await ws.list(undefined, 400);
  const set = new Set(files);
  const parts: string[] = [`Workspace files (${files.length}${files.length >= 400 ? "+" : ""}):\n${fileTree(files)}`];

  for (const m of MANIFESTS) {
    if (!set.has(m)) {
      continue;
    }
    let text = (await ws.read(m)) ?? "";
    if (m === "package.json") {
      try {
        const pkg = JSON.parse(text) as Record<string, unknown>;
        text = JSON.stringify(
          { name: pkg.name, type: pkg.type, engines: pkg.engines, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies },
          null,
          1,
        );
      } catch {
        // keep the raw head
      }
    }
    parts.push(`${m}:\n${text.split("\n").slice(0, 50).join("\n")}`);
  }

  const readme = files.find((f) => /^readme(\.md|\.rst|\.txt)?$/i.test(f));
  if (readme) {
    const text = (await ws.read(readme)) ?? "";
    parts.push(`${readme} (head):\n${text.split("\n").slice(0, 30).join("\n")}`);
  }

  // Outlines of the local modules this file imports.
  const local = current.imports
    .map((spec) => resolveImport(spec, file, current.language, set))
    .filter((f): f is string => !!f && f !== file);
  for (const rel of [...new Set(local)].slice(0, 5)) {
    const text = await ws.read(rel);
    if (text === undefined) {
      continue;
    }
    const o = await outlineOf(rel, text);
    const body = formatOutline(o).split("\n").slice(0, 40).join("\n");
    const planned = (plannedOf?.(rel) ?? []).slice(0, 15);
    const plan = planned.length ? `\nPlanned in ${rel} but not typed yet:\n${planned.map((p) => `- ${p}`).join("\n")}` : "";
    parts.push(`Imported module ${rel}${o.moduleString ? ` — ${o.moduleString.text.split("\n")[0]}` : ""}:\n${body}${plan}`);
  }

  // Sibling modules (first docstring line only) show the neighbourhood.
  const dir = path.posix.dirname(file);
  const shown = new Set(local);
  const siblings = files
    .filter((f) => f !== file && !shown.has(f) && path.posix.dirname(f) === dir && ws.languageOf(f) === current.language)
    .slice(0, 8);
  const sibLines: string[] = [];
  for (const rel of siblings) {
    const text = await ws.read(rel);
    if (text === undefined) {
      continue;
    }
    const o = await outlineOf(rel, text);
    const names = o.symbols.filter((s) => !s.parent && s.kind !== "variable").map((s) => s.name);
    sibLines.push(`- ${rel}: ${o.moduleString?.text.split("\n")[0] ?? "(no docstring)"}${names.length ? ` [${names.slice(0, 8).join(", ")}]` : ""}`);
  }
  if (sibLines.length) {
    parts.push(`Other modules in ${dir === "." ? "the root folder" : dir + "/"}:\n${sibLines.join("\n")}`);
  }
  return parts.join("\n\n");
}
