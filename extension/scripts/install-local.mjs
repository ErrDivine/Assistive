// Install Reference Rail from this checkout into VS Code (or VSCodium / Cursor).
//
//   node scripts/install-local.mjs [--editor code|codium|cursor|insiders] [--copy]
//
// 1. creates the server's own virtualenv (server/.venv) with uv, or python -m venv + pip;
// 2. builds the extension (production bundle);
// 3. links this folder into the editor's extensions directory (a directory junction on
//    Windows), or copies it with --copy (then the server sources are copied alongside).
// Restart the editor afterwards. Steps 1 downloads Python packages from PyPI.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..");
const server = path.resolve(ext, "..", "server");
const pkg = JSON.parse(fs.readFileSync(path.join(ext, "package.json"), "utf8"));
const args = process.argv.slice(2);
const editor = args.includes("--editor") ? args[args.indexOf("--editor") + 1] : "code";
const copy = args.includes("--copy");

const dirs = {
  code: ".vscode/extensions",
  insiders: ".vscode-insiders/extensions",
  codium: ".vscode-oss/extensions",
  cursor: ".cursor/extensions",
};
if (!dirs[editor]) {
  console.error(`unknown editor ${editor}; use one of ${Object.keys(dirs).join(", ")}`);
  process.exit(2);
}

function run(cmd, cmdArgs, cwd) {
  console.log(`$ ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function has(cmd) {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
    return true;
  } catch {
    return false;
  }
}

// 1. Server environment.
const venvPy = process.platform === "win32"
  ? path.join(server, ".venv", "Scripts", "python.exe")
  : path.join(server, ".venv", "bin", "python");
if (!fs.existsSync(venvPy)) {
  if (has("uv")) {
    run("uv", ["sync", "--frozen", "--no-dev"], server);
  } else {
    const py = process.platform === "win32" ? "python" : "python3";
    run(py, ["-m", "venv", ".venv"], server);
    run(venvPy, ["-m", "pip", "install", "--disable-pip-version-check", "."], server);
  }
}

// 2. Build.
if (!fs.existsSync(path.join(ext, "node_modules"))) {
  run("npm", ["ci"], ext);
}
run("node", ["esbuild.mjs", "--production"], ext);

// 3. Link or copy into the editor's extensions folder.
const target = path.join(os.homedir(), dirs[editor], `${pkg.publisher}.${pkg.name}-${pkg.version}`);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.rmSync(target, { recursive: true, force: true });
if (copy) {
  for (const item of ["package.json", "dist", "media"]) {
    fs.cpSync(path.join(ext, item), path.join(target, item), { recursive: true });
  }
  fs.cpSync(server, path.join(target, "server"), {
    recursive: true,
    filter: (src) => !/[\\/](\.mypy_cache|\.pytest_cache|\.ruff_cache|__pycache__|tests)$/.test(src),
  });
} else {
  fs.symlinkSync(ext, target, process.platform === "win32" ? "junction" : "dir");
}
console.log(`\nInstalled to ${target}. Restart ${editor} and open a Python project.`);
console.log("Optional, for better precedent search (downloads ~90 MB once):");
console.log("  Command Palette → \"Reference Rail: Download Embedding Model\"");
