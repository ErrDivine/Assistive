// Install Assistive from this checkout into VS Code (or VSCodium / Cursor).
//
//   node scripts/install-local.mjs [--editor code|codium|cursor|insiders] [--copy]
//
// 1. builds the extension (production bundle);
// 2. links this folder into the editor's extensions directory (a directory junction on
//    Windows), or copies the built files with --copy;
// 3. creates the .env with placeholders if there is none: <repo>/.env when linked,
//    ~/.assistive/.env when copied.
// Restart the editor afterwards, fill in the .env, and open a Python/TypeScript file.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..");
const repo = path.resolve(ext, "..");
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

// 1. Build.
if (!fs.existsSync(path.join(ext, "node_modules"))) {
  run("npm", ["ci"], ext);
}
run("node", ["esbuild.mjs", "--production"], ext);

// 2. Link or copy into the editor's extensions folder.
const target = path.join(os.homedir(), dirs[editor], `${pkg.publisher}.${pkg.name}-${pkg.version}`);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.rmSync(target, { recursive: true, force: true });
if (copy) {
  for (const item of ["package.json", "dist", "media"]) {
    fs.cpSync(path.join(ext, item), path.join(target, item), { recursive: true });
  }
} else {
  fs.symlinkSync(ext, target, process.platform === "win32" ? "junction" : "dir");
}

// 3. The API configuration, with placeholders to fill in.
const envFile = copy ? path.join(os.homedir(), ".assistive", ".env") : path.join(repo, ".env");
if (!fs.existsSync(envFile)) {
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.copyFileSync(path.join(repo, ".env.example"), envFile);
  fs.chmodSync(envFile, 0o600);
  console.log(`Created ${envFile} from .env.example.`);
}

console.log(`\nInstalled to ${target}.`);
console.log(`Next: fill in the REPLACE_ME values in ${envFile}, restart ${editor}, and open a Python or TypeScript file.`);
console.log('Check the setup any time with Command Palette → "Assistive: Test LLM and Jev Connections".');
