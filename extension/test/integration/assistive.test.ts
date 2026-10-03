// End-to-end inside VS Code: the real extension against fake OpenAI and Jev
// servers. The test types the module docstring and code like a programmer.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AssistiveApi } from "../../src/extension";
import type { FeedItem, FileGraph } from "../../src/types";
import { FakeServers, jevAnswers, scriptedAssistant, systemPrompt } from "../support/fakeServers";

const workspace = process.env.ASSISTIVE_IT_WORKSPACE!;
const envFile = process.env.ASSISTIVE_IT_ENV!;
const wcPath = path.join(workspace, "wc.py");

async function waitFor<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** True while the test itself is typing. */
let typing = false;

async function typeText(text: string, chunk = 12): Promise<void> {
  // Insert in chunks at the selection (the "type" command would auto-indent).
  const editor = vscode.window.activeTextEditor!;
  typing = true;
  try {
    for (let i = 0; i < text.length; i += chunk) {
      const piece = text.slice(i, i + chunk);
      const sel = editor.selection;
      await editor.edit((eb) => (sel.isEmpty ? eb.insert(sel.active, piece) : eb.replace(sel, piece)));
      const end = editor.selection.end;
      editor.selection = new vscode.Selection(end, end);
    }
    await new Promise((r) => setTimeout(r, 200)); // let change events arrive
  } finally {
    typing = false;
  }
}

describe("Assistive in VS Code", function () {
  let fake: FakeServers;
  let api: AssistiveApi;
  let editor: vscode.TextEditor;
  /** What the test itself typed; the extension must never change the buffer (I1). */
  let expected = "";
  const foreignChanges: string[] = [];

  const c = () => api.controller;
  const key = () => editor.document.uri.fsPath;
  const feed = () => c().store.get(key()).feed;
  const graph = () => c().store.graph(key());
  const ofKind = <K extends FeedItem["kind"]>(k: K) => feed().filter((f): f is Extract<FeedItem, { kind: K }> => f.kind === k);

  before(async () => {
    fake = await new FakeServers().start();
    fake.chat = scriptedAssistant(fake.base, { interruptLine: 7 });
    fake.jev = (req) => ({ body: jevAnswers(req, { interrupt: 0.05, issue: "none", severity: 0 }) });
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(
      envFile,
      [
        `ASSISTIVE_LLM_BASE_URL=${fake.base}/v1`,
        "ASSISTIVE_LLM_API_KEY=sk-test",
        "ASSISTIVE_LLM_MODEL=fake-model",
        `ASSISTIVE_JEV_BASE_URL=${fake.base}/v1`,
        "ASSISTIVE_JEV_API_KEY=jev-test",
        "ASSISTIVE_HEARTBEAT_SECONDS=600",
      ].join("\n"),
    );
    const ext = vscode.extensions.getExtension<AssistiveApi>("errdivine.assistive");
    assert.ok(ext, "extension is installed");
    api = await ext.activate();
    c().reloadConfig();
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.fsPath === wcPath && e.contentChanges.length && !typing) {
        foreignChanges.push(e.contentChanges.map((x) => x.text).join(""));
      }
    });
  });

  after(async () => {
    await fake.stop();
  });

  it("ignores a workspace setting that redirects the API configuration", async () => {
    // The scratch workspace sets assistive.envFile to a decoy; only the user setting counts.
    assert.strictEqual(vscode.workspace.getConfiguration("assistive").get("envFile"), envFile);
    assert.strictEqual(c().lastPanelState?.status.configPath ?? envFile, envFile);
    await assert.rejects(
      Promise.resolve(vscode.workspace.getConfiguration("assistive").update("envFile", "/tmp/evil/.env", vscode.ConfigurationTarget.Workspace)),
    );
  });

  it("registers its commands and the panel", async () => {
    const cmds = await vscode.commands.getCommands(true);
    for (const id of ["assistive.focus", "assistive.ask", "assistive.draftGraph", "assistive.heartbeatNow", "assistive.openConfig", "assistive.testConnection"]) {
      assert.ok(cmds.includes(id), id);
    }
    await vscode.commands.executeCommand("assistive.focus");
    await waitFor("panel visible", () => c().panel.visible);
  });

  it("tests the LLM and Jev connections", async () => {
    const lines = await c().testConnection();
    assert.match(lines[0], /^LLM fake-model: OK in \d+ ms$/);
    assert.match(lines[1], /^Jev jev-1.13.0: answered in \d+ ms/);
    const st = await waitFor("usage counted", () => ((c().lastPanelState?.status.llmUsage?.requests ?? 0) >= 1 ? c().lastPanelState?.status : undefined));
    assert.strictEqual(st.llmModel, "fake-model");
    assert.ok(st.llmUsage!.prompt > 0);
  });

  it("does not draft files that are only opened", async () => {
    const other = await vscode.workspace.openTextDocument(path.join(workspace, "existing.py"));
    await vscode.window.showTextDocument(other, vscode.ViewColumn.One);
    await waitFor("panel shows the file", () => c().lastPanelState?.file === "existing.py");
    await new Promise((r) => setTimeout(r, 3500));
    assert.strictEqual(c().store.graph(other.uri.fsPath), undefined);
    assert.strictEqual(fake.chatRequests.filter((r) => /Task: draft/.test(systemPrompt(r))).length, 0);
    assert.strictEqual(c().lastPanelState?.moduleStringClosed, true);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  it("supports Go files: the package comment is the module docstring", async () => {
    const goDoc = await vscode.workspace.openTextDocument(path.join(workspace, "greet.go"));
    await vscode.window.showTextDocument(goDoc, vscode.ViewColumn.One);
    const st = await waitFor("panel shows greet.go", () => (c().lastPanelState?.file === "greet.go" ? c().lastPanelState : undefined));
    assert.strictEqual(goDoc.languageId, "go");
    assert.strictEqual(st.supported, true);
    assert.strictEqual(st.moduleString, "Package greet says hello in several languages.");
    assert.strictEqual(st.moduleStringClosed, true);
    const o = await c().outlineOf("greet.go", goDoc.getText(), "go");
    assert.deepStrictEqual(o.symbols.map((s) => [s.qualname, s.isStub]), [["Hello", true]]);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  it("asks to save an untitled buffer before planning it", async () => {
    const untitled = await vscode.workspace.openTextDocument({ language: "python", content: '"""A scratch module."""\n' });
    await vscode.window.showTextDocument(untitled, vscode.ViewColumn.One);
    const st = await waitFor("unsaved state", () => (c().lastPanelState?.unsaved ? c().lastPanelState : undefined));
    assert.strictEqual(st.supported, false);
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  });

  it("drafts the graph once the module docstring is written", async () => {
    const doc = await vscode.workspace.openTextDocument(wcPath);
    editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const docstring = '"""Count the most common words in a text file and print them."""\n';
    expected = docstring;
    await typeText(docstring);
    assert.strictEqual(editor.document.getText(), expected);
    const g = await waitFor("auto-draft", () => (graph()?.nodes.length ? graph() : undefined));
    assert.deepStrictEqual(g.nodes.map((n) => n.id), ["parse_line", "count_words", "main", "counter"]);
    assert.strictEqual(g.file, "wc.py");
    const draftReq = fake.chatRequests.find((r) => /Task: draft/.test(systemPrompt(r)))!;
    assert.match(draftReq.messages[1].content ?? "", /README.md \(head\):\n# Word count/);
    const resources = await waitFor("resources", () => ofKind("resources")[0]);
    assert.deepStrictEqual(resources.items.map((r) => r.verified), ["ok"]);
    assert.ok(fake.linkRequests.some((r) => r.url === "/docs/missing"), "the dead link was checked");
    // The graph shows up as a live preview during the turn; the summary comes when the turn ends.
    const summary = await waitFor("draft summary", () => ofKind("assistant")[0]);
    assert.match(summary.text, /start with `parse_line`/);
    // The panel received the state.
    await waitFor("panel state", () => c().lastPanelState?.graph?.nodes.length === 4);
    assert.strictEqual(c().lastPanelState?.moduleStringClosed, true);
  });

  it("changes the graph from an instruction and summarizes", async () => {
    await c().send("Add a helper that returns the top N words.");
    assert.ok(graph()!.nodes.some((n) => n.id === "top_n"));
    assert.match(ofKind("assistant").at(-1)!.text, /Added a `top_n` helper/);
    assert.ok(ofKind("user").some((u) => u.text.startsWith("Add a helper")));
  });

  it("undoes the last graph change", async () => {
    await vscode.commands.executeCommand("assistive.undoGraph");
    assert.ok(!graph()!.nodes.some((n) => n.id === "top_n"));
  });

  it("lets the programmer mark a step done and remove a node without the LLM (undoable)", async () => {
    const requests = fake.chatRequests.length;
    const counter = () => graph()!.nodes.find((n) => n.id === "counter");
    await c().editNode("counter", "toggleDone");
    assert.strictEqual(counter()?.status, "done", "an external node's status is set by the programmer");
    await c().editNode("counter", "toggleDone");
    assert.strictEqual(counter()?.status, "planned");
    await c().editNode("parse_line", "toggleDone");
    assert.strictEqual(graph()!.nodes.find((n) => n.id === "parse_line")?.status, "planned", "code nodes follow the code");
    await c().editNode("counter", "remove");
    assert.strictEqual(counter(), undefined);
    assert.ok(!graph()!.edges.some((e) => e.to === "counter"), "its edges went too");
    await vscode.commands.executeCommand("assistive.undoGraph");
    assert.ok(counter(), "undo brings it back");
    assert.strictEqual(fake.chatRequests.length, requests, "no LLM request");
  });

  it("tracks the code the programmer types", async () => {
    const code = "\nfrom collections import Counter\n\n\ndef parse_line(line: str) -> list[str]:\n    pass\n";
    expected += code;
    editor.selection = new vscode.Selection(editor.document.lineCount, 0, editor.document.lineCount, 0);
    await typeText(code, 40);
    assert.strictEqual(editor.document.getText(), expected);
    await editor.document.save();
    await waitFor("parse_line stubbed", () => graph()!.nodes.find((n) => n.id === "parse_line")?.status === "stubbed");
    assert.strictEqual(graph()!.nodes.find((n) => n.id === "parse_line")!.line, 5);
  });

  it("updates statuses while the programmer types, before a save", async () => {
    const more = "\n\ndef count_words(lines):\n    return Counter(w for l in lines for w in parse_line(l))\n";
    expected += more;
    const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(end, end);
    await typeText(more, 40);
    assert.strictEqual(editor.document.getText(), expected);
    assert.ok(editor.document.isDirty, "not saved");
    await waitFor("count_words done", () => graph()!.nodes.find((n) => n.id === "count_words")?.status === "done", 5000);
  });

  it("shows progress and the next piece in a code lens above the docstring", async () => {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", editor.document.uri);
    const mine = lenses.filter((l) => /Assistive|^Next:/.test(l.command?.title ?? ""));
    assert.deepStrictEqual(
      mine.map((l) => l.command?.title),
      ["$(type-hierarchy) Assistive: 1/3 done", "Next: def parse_line(line: str) -> list[str]"],
    );
    assert.strictEqual(mine[0].range.start.line, 0);
    assert.deepStrictEqual([mine[1].command?.command, mine[1].command?.arguments], ["assistive.showNode", ["parse_line"]]);
    await vscode.commands.executeCommand("assistive.showNode", "parse_line"); // opens the panel; must not throw
  });

  it("shows the plan of a symbol on hover", async () => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", editor.document.uri, new vscode.Position(5, 6));
    const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : c.value))).join("\n");
    assert.match(text, /\*\*Assistive plan\*\* · stubbed · step 1 of 4/);
    assert.match(text, /def parse_line\(line: str\) -> list\[str\]/);
    assert.match(text, /Split one line into lowercase words/);
  });

  it("stays quiet on a calm heartbeat", async () => {
    const before = feed().length;
    const r = await c().beatNow();
    assert.strictEqual(r?.outcome, "no_action");
    assert.strictEqual(r?.verdict?.source, "jev");
    assert.strictEqual(feed().length, before);
    const state = fake.jevRequests.at(-1)!.body.state as Record<string, unknown>;
    assert.strictEqual(state.file, "wc.py");
    assert.ok((state.plan as { nodes: unknown[] }).nodes.length >= 4);
  });

  it("interrupts on a real problem, squiggles the line, and resolves when fixed", async () => {
    // Replace `pass` with a buggy body.
    const passLine = editor.document.lineAt(6);
    editor.selection = new vscode.Selection(6, 4, 6, passLine.text.length);
    const buggy = "return [w.lowr() for w in line.split()]";
    expected = expected.replace("    pass\n", `    ${buggy}\n`);
    await typeText(buggy, 40);
    assert.strictEqual(editor.document.getText(), expected);
    fake.jev = (req) => ({ body: jevAnswers(req, { interrupt: 0.93, issue: "typo", severity: 3 }) });
    const r = await c().beatNow();
    assert.strictEqual(r?.outcome, "interrupted");
    const intr = ofKind("interrupt")[0];
    assert.strictEqual(intr.title, "Typo in a method name");
    assert.strictEqual(intr.line, 6);
    const diags = await waitFor("squiggle", () => {
      const d = vscode.languages.getDiagnostics(editor.document.uri).filter((x) => x.source === "Assistive");
      return d.length ? d : undefined;
    });
    assert.strictEqual(diags[0].range.start.line, 6);
    assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
    assert.strictEqual(diags[0].code, "typo");
    await waitFor("node flagged", () => graph()!.nodes.find((n) => n.id === "parse_line")?.status === "attention");
    // The lightbulb on the squiggle offers explain and dismiss: commands only, never an edit (I1).
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", editor.document.uri, diags[0].range);
    const mine = actions.filter((a) => a.title.endsWith("(Assistive)"));
    assert.deepStrictEqual(
      mine.map((a) => [a.title, a.command?.command, a.command?.arguments?.[0]]),
      [
        ["Explain: Typo in a method name (Assistive)", "assistive.explainNote", intr.id],
        ["Got it: dismiss this note (Assistive)", "assistive.dismissNote", intr.id],
      ],
    );
    assert.ok(mine.every((a) => !a.edit), "no quick fix edits the code");

    // The programmer fixes the line: the interrupt resolves and the squiggle goes away.
    const lowr = editor.document.lineAt(6).text.indexOf("lowr");
    editor.selection = new vscode.Selection(6, lowr, 6, lowr + 4);
    expected = expected.replace("w.lowr()", "w.lower()");
    await typeText("lower");
    assert.strictEqual(editor.document.getText(), expected);
    await waitFor("interrupt resolved", () => ofKind("interrupt")[0].status === "resolved");
    await waitFor("squiggle cleared", () => !vscode.languages.getDiagnostics(editor.document.uri).some((x) => x.source === "Assistive"));
    await waitFor("node unflagged", () => graph()!.nodes.find((n) => n.id === "parse_line")?.status === "done");
  });

  it("exports the graph as Markdown (Mermaid and a step checklist) in a new untitled document", async () => {
    await vscode.commands.executeCommand("assistive.exportGraph");
    const md = await waitFor("export", () =>
      vscode.window.activeTextEditor?.document.isUntitled ? vscode.window.activeTextEditor.document : undefined,
    );
    assert.match(md.getText(), /```mermaid\nflowchart TD\n {2}parse_line\[/);
    assert.match(md.getText(), /\n## Steps\n\n1\. \[[ x]\] \*\*/);
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  });

  it("moves a file's graph when the file or its folder is renamed in VS Code", async () => {
    const oldPath = path.join(workspace, "plan_me.py");
    fs.writeFileSync(oldPath, '"""A file whose plan must survive a rename."""\n');
    const plan: FileGraph = {
      file: "plan_me.py",
      language: "python",
      moduleString: "A file whose plan must survive a rename.",
      nodes: [{ id: "run", kind: "function", label: "run", symbol: "run", description: "Run it.", notes: [], status: "planned" }],
      edges: [],
      revision: 1,
      updatedAt: new Date().toISOString(),
    };
    c().store.setGraph(oldPath, plan, false);
    const rename = async (from: string, to: string) => {
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(vscode.Uri.file(from), vscode.Uri.file(to));
      assert.ok(await vscode.workspace.applyEdit(edit));
    };
    const newPath = path.join(workspace, "pkg", "planned.py");
    await rename(oldPath, newPath);
    await waitFor("graph moved", () => c().store.graph(newPath)?.file === "pkg/planned.py");
    assert.strictEqual(c().store.graph(oldPath), undefined);
    const movedPath = path.join(workspace, "lib", "planned.py");
    await rename(path.join(workspace, "pkg"), path.join(workspace, "lib"));
    await waitFor("graph moved with its folder", () => c().store.graph(movedPath)?.file === "lib/planned.py");
    assert.deepStrictEqual(c().store.graph(movedPath)?.nodes.map((n) => n.id), ["run"]);
    assert.ok(c().store.plannedFiles().some((p) => p.file === movedPath));
    assert.ok(!c().store.plannedFiles().some((p) => p.file === newPath || p.file === oldPath));
  });

  it("finds the plan of a file that was renamed outside VS Code by its docstring", async () => {
    const doc = '"""Parse feeds and keep the newest entries for each source."""\n';
    const before = path.join(workspace, "feeds_old.py");
    const after = path.join(workspace, "feeds.py");
    fs.writeFileSync(before, doc);
    c().store.setGraph(
      before,
      {
        file: "feeds_old.py",
        language: "python",
        moduleString: "Parse feeds and keep the newest entries for each source.",
        nodes: [{ id: "parse", kind: "function", label: "parse", symbol: "parse", description: "Parse one feed.", notes: [], status: "planned" }],
        edges: [],
        revision: 1,
        updatedAt: new Date().toISOString(),
      },
      false,
    );
    fs.renameSync(before, after); // like git mv: VS Code sends no rename event
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(after), vscode.ViewColumn.One);
    await waitFor("plan adopted", () => c().store.graph(after)?.file === "feeds.py");
    assert.strictEqual(c().store.graph(before), undefined);
    const note = c().store.get(after).feed.find((f) => f.kind === "system");
    assert.match(note && note.kind === "system" ? note.text : "", /Moved the plan of feeds_old\.py here/);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  it("creates the .env template when the configured file is missing", async () => {
    const fresh = path.join(path.dirname(envFile), "fresh", ".env");
    await vscode.workspace.getConfiguration("assistive").update("envFile", fresh, vscode.ConfigurationTarget.Global);
    try {
      await c().openConfig();
      assert.ok(fs.existsSync(fresh));
      assert.match(fs.readFileSync(fresh, "utf8"), /ASSISTIVE_LLM_API_KEY=REPLACE_ME/);
      assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, fresh);
      await waitFor("llm missing", () => c().lastPanelState?.status.llm === "missing");
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    } finally {
      await vscode.workspace.getConfiguration("assistive").update("envFile", envFile, vscode.ConfigurationTarget.Global);
    }
    await waitFor("llm ready again", () => c().lastPanelState?.status.llm === "ready");
  });

  it("sets up the LLM with the wizard: endpoint, key, a listed model and the triage", async () => {
    const fresh = path.join(path.dirname(envFile), "wizard", ".env");
    await vscode.workspace.getConfiguration("assistive").update("envFile", fresh, vscode.ConfigurationTarget.Global);
    try {
      await waitFor("llm missing", () => c().lastPanelState?.status.llm === "missing");
      const usedBefore = c().sessionUsage().requests;
      const answers: string[] = ["Other OpenAI-compatible endpoint…", `${fake.base}/v1`, "sk-wizard", "fake-model", "Triage with the LLM"];
      const offered: string[][] = [];
      const ok = await c().setup({
        pick: async (items) => {
          offered.push(items.map((i) => i.label));
          const want = answers.shift();
          return items.find((i) => i.label === want);
        },
        input: async () => answers.shift(),
      });
      assert.strictEqual(ok, true);
      assert.deepStrictEqual(answers, []);
      assert.ok(offered[1].includes("fake-model") && !offered[1].includes("fake-embedding"), "the endpoint's chat models are offered");
      const text = fs.readFileSync(fresh, "utf8");
      assert.match(text, new RegExp(`^ASSISTIVE_LLM_BASE_URL=${fake.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/v1$`, "m"));
      assert.match(text, /^ASSISTIVE_LLM_API_KEY=sk-wizard$/m);
      assert.match(text, /^ASSISTIVE_LLM_MODEL=fake-model$/m);
      assert.match(text, /^ASSISTIVE_TRIAGE=llm$/m);
      assert.match(text, /^# Assistive configuration/, "the template comments stay");
      assert.strictEqual(fake.modelRequests.at(-1)?.authorization, "Bearer sk-wizard");
      await waitFor("llm ready", () => c().lastPanelState?.status.llm === "ready" && c().lastPanelState?.status.triage === "llm");
      assert.ok(c().sessionUsage().requests > usedBefore, "the session total survives configuration reloads");
    } finally {
      await vscode.workspace.getConfiguration("assistive").update("envFile", envFile, vscode.ConfigurationTarget.Global);
    }
    await waitFor("original config again", () => c().lastPanelState?.status.triage === "jev");
  });

  it("never modified the programmer's buffer (I1)", () => {
    assert.deepStrictEqual(foreignChanges, []);
    assert.strictEqual(fs.readFileSync(wcPath, "utf8").startsWith('"""Count the most common words'), true);
  });
});
