// Bundles the extension host code and the rail webview script.
import * as esbuild from "esbuild";
import { readdirSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");
const production = process.argv.includes("--production");

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: "info" };

const builds = [
  {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
  },
  {
    ...common,
    entryPoints: ["src/rail/webview/rail.ts"],
    outfile: "dist/webview/rail.js",
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
    target: "node20",
    external: ["vscode", "mocha", "@vscode/test-electron"],
  });
}

mkdirSync("dist/webview", { recursive: true });
copyFileSync("src/rail/webview/rail.css", "dist/webview/rail.css");
copyFileSync("src/rail/webview/index.html", "dist/webview/index.html");

if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
