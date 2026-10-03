// Bundles the extension host code, the panel webview and the tree-sitter WASM files.
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");
const production = process.argv.includes("--production");

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: "warning" };

const builds = [
  {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["vscode"],
  },
  {
    ...common,
    entryPoints: ["src/panel/webview/panel.ts"],
    outfile: "dist/webview/panel.js",
    platform: "browser",
    format: "iife",
    target: "es2022",
  },
];

function listTests(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTests(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

if (tests) {
  builds.push({
    ...common,
    entryPoints: listTests("test"),
    outdir: "out/test",
    outbase: "test",
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["vscode", "mocha", "@vscode/test-electron"],
  });
}

// Static assets: webview template + styles, tree-sitter runtime and grammars.
mkdirSync("dist/webview", { recursive: true });
mkdirSync("dist/wasm", { recursive: true });
copyFileSync("src/panel/webview/index.html", "dist/webview/index.html");
copyFileSync("src/panel/webview/panel.css", "dist/webview/panel.css");
const wasmDir = "node_modules/@vscode/tree-sitter-wasm/wasm";
const grammars = ["python", "typescript", "tsx", "javascript", "go", "rust", "java"];
for (const f of ["tree-sitter.wasm", ...grammars.map((g) => `tree-sitter-${g}.wasm`)]) {
  copyFileSync(join(wasmDir, f), join("dist/wasm", f));
}

if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
