// Launches VS Code (or VSCodium via VSCODE_EXECUTABLE) on the fixture app and
// runs test/integration/*.test.ts inside the extension host.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./integration/index");
  const repo = path.resolve(extensionDevelopmentPath, "..");
  const fixtures = path.join(repo, "eval", "fixtures");
  const workspace = path.join(fixtures, "fixture_app");
  if (!fs.existsSync(workspace)) {
    throw new Error("Run `python eval/fixtures/make_fixtures.py` first.");
  }
  const venvPython =
    process.platform === "win32"
      ? path.join(fixtures, ".venv", "Scripts", "python.exe")
      : path.join(fixtures, ".venv", "bin", "python");
  // Scratch files (rail_it_*) would be indexed as workspace code: remove them
  // before and after the run so the fixture stays clean for the evaluation.
  const cleanScratch = () => {
    for (const dir of [workspace, path.join(workspace, "app")]) {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith("rail_it_")) {
          fs.rmSync(path.join(dir, f), { force: true });
        }
      }
    }
  };
  cleanScratch();
  // Workspace settings for the run (fixture_app is a generated directory).
  fs.mkdirSync(path.join(workspace, ".vscode"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, ".vscode", "settings.json"),
    JSON.stringify(
      {
        "referenceRail.pythonPath": venvPython,
        "referenceRail.indexStdlib": true,
        "referenceRail.extraRepos": [path.join(fixtures, "fixture_history")],
        "referenceRail.embeddingBackend": "hashing",
        "referenceRail.recordSessions": true,
      },
      null,
      2,
    ),
  );
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rail-it-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "rail-ud-"));
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
      extensionTestsEnv: {
        REFERENCE_RAIL_HOME: home,
        RAIL_FIXTURES: fixtures,
        RAIL_STRESS_SECONDS: process.env.RAIL_STRESS_SECONDS ?? "60",
      },
    });
  } finally {
    cleanScratch();
    fs.rmSync(path.join(workspace, ".vscode"), { recursive: true, force: true });
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
