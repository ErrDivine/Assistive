// Launches VS Code (or VSCodium via VSCODE_EXECUTABLE) on a scratch workspace
// and runs test/integration/*.test.ts inside the extension host. The tests
// start their own fake OpenAI/Jev servers and point the extension at them
// through a temporary .env file.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./integration/index");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "assistive-it-"));
  const workspace = path.join(scratch, "project");
  const envFile = path.join(scratch, "config", ".env");
  fs.mkdirSync(path.join(workspace, ".vscode"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "wc.py"), "");
  fs.writeFileSync(path.join(workspace, "existing.py"), '"""An existing module that is only opened, never edited."""\n\nVALUE = 1\n');
  fs.writeFileSync(path.join(workspace, "README.md"), "# Word count\n\nA tiny CLI that counts words.\n");
  fs.writeFileSync(
    path.join(workspace, "greet.go"),
    '// Package greet says hello in several languages.\npackage greet\n\nfunc Hello(lang string) string {\n\tpanic("not implemented")\n}\n',
  );
  fs.writeFileSync(path.join(workspace, "pyproject.toml"), '[project]\nname = "wc"\nversion = "0.1.0"\ndependencies = []\n');
  fs.writeFileSync(
    path.join(workspace, ".vscode", "settings.json"),
    JSON.stringify({ "assistive.envFile": envFile, "assistive.notifications": "panel" }, null, 2),
  );
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "assistive-ud-"));
  let code = 1;
  try {
    code = await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || undefined,
      version: process.env.VSCODE_VERSION || "stable",
      launchArgs: [
        workspace,
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        "--no-sandbox",
        "--disable-gpu",
        `--user-data-dir=${userData}`,
      ],
      extensionTestsEnv: { ASSISTIVE_IT_WORKSPACE: workspace, ASSISTIVE_IT_ENV: envFile },
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
