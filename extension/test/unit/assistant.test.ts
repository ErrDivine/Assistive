import * as assert from "node:assert";
import * as path from "node:path";
import { Assistant, type FileHandle, scopeCode } from "../../src/assistant/Assistant";
import { EditTracker } from "../../src/code/changes";
import { outline } from "../../src/code/outline";
import { TreeSitter } from "../../src/code/treesitter";
import { parseConfig } from "../../src/config/env";
import { Heartbeat, type BeatReport } from "../../src/heartbeat/Heartbeat";
import { Llm } from "../../src/llm/agent";
import { JevClient } from "../../src/llm/jev";
import { checkLinks } from "../../src/resources/links";
import { GraphStore } from "../../src/store/GraphStore";
import type { FeedItem } from "../../src/types";
import { FakeServers, jevAnswers, scriptedAssistant, systemPrompt } from "../support/fakeServers";
import { MemoryWorkspace } from "../support/memoryWorkspace";

const ts = new TreeSitter(path.resolve(__dirname, "../../../node_modules/@vscode/tree-sitter-wasm/wasm"));

const DOC = '"""Count the most common words in a text file and print them."""\n';

function harness(fake: FakeServers, triage: "jev" | "llm" | "off" = "jev", now: () => number = Date.now) {
  const config = parseConfig({
    ASSISTIVE_LLM_BASE_URL: `${fake.base}/v1`,
    ASSISTIVE_LLM_API_KEY: "sk-test",
    ASSISTIVE_LLM_MODEL: "fake-model",
    ASSISTIVE_JEV_BASE_URL: `${fake.base}/v1`,
    ASSISTIVE_JEV_API_KEY: "jev-key",
    ASSISTIVE_TRIAGE: triage,
  });
  const store = new GraphStore(undefined);
  const edits = new EditTracker(now);
  const ws = new MemoryWorkspace({ "wc.py": DOC, "pyproject.toml": '[project]\nname = "wc"\ndependencies = []\n' });
  let text = DOC;
  let cursor = 0;
  const h: FileHandle = { key: "/ws/wc.py", file: "wc.py", ws, language: "python", text: () => text, cursorLine: () => cursor };
  const busy: (string | undefined)[] = [];
  const streams: (string | undefined)[] = [];
  const logs: string[] = [];
  const llm = new Llm(config.llm);
  const outlineOf = (rel: string, t: string, language?: string) => outline(ts, language ?? (rel.endsWith(".py") ? "python" : "plaintext"), t);
  const assistant = new Assistant({
    llm: () => llm,
    store,
    edits,
    outlineOf,
    checkLinks: (items) => checkLinks(items, { verify: true, timeoutMs: 2000 }),
    setBusy: (_k, label) => busy.push(label),
    setStreaming: (_k, text) => streams.push(text),
    log: (m) => logs.push(m),
  });
  const reports: BeatReport[] = [];
  const heartbeat = new Heartbeat({
    config: () => config,
    enabled: () => true,
    jev: () => new JevClient(config.jev),
    llm: () => llm,
    active: () => h,
    focused: () => true,
    edits,
    store,
    assistant,
    outlineOf,
    onBeat: (r) => reports.push(r),
    log: (m) => logs.push(m),
    now,
  });
  edits.open(h.key, text);
  return {
    h,
    store,
    edits,
    assistant,
    heartbeat,
    busy,
    streams,
    logs,
    reports,
    type(newText: string, line: number) {
      text = newText;
      cursor = line;
      edits.edited(h.key, [line]);
    },
  };
}

const feedOf = (store: GraphStore, kind: FeedItem["kind"]) => store.get("/ws/wc.py").feed.filter((f) => f.kind === kind);

describe("Assistant + Heartbeat with fake OpenAI and Jev servers", () => {
  let fake: FakeServers;
  before(async () => {
    fake = await new FakeServers().start();
  });
  after(() => fake.stop());
  beforeEach(() => {
    fake.reset();
    fake.chat = scriptedAssistant(fake.base, { interruptLine: 5 });
  });

  it("drafts the graph from the module docstring with project context", async () => {
    const t = harness(fake);
    await t.assistant.draft(t.h);
    const g = t.store.graph("/ws/wc.py")!;
    assert.deepStrictEqual(
      g.nodes.map((n) => [n.id, n.status]),
      [
        ["parse_line", "planned"],
        ["count_words", "planned"],
        ["main", "planned"],
        ["counter", "planned"],
      ],
    );
    assert.strictEqual(g.edges.length, 3);
    assert.strictEqual(g.moduleString, "Count the most common words in a text file and print them.");
    assert.strictEqual(g.revision, 1);
    // The prompt carried the docstring and project context; the draft used the draft tools.
    const first = fake.chatRequests[0];
    assert.match(systemPrompt(first), /Task: draft the implementation graph/);
    assert.match(systemPrompt(first), /The programmer types every line of code/);
    const user = first.messages[1].content ?? "";
    assert.match(user, /## Module docstring\nCount the most common words/);
    assert.match(user, /## Project context\nWorkspace files/);
    assert.match(user, /pyproject.toml:\n\[project\]/);
    // Resources were link-checked against the fake docs server: the 404 was dropped.
    const res = feedOf(t.store, "resources")[0] as Extract<FeedItem, { kind: "resources" }>;
    assert.deepStrictEqual(res.items.map((r) => [r.title, r.verified]), [["collections.Counter", "ok"]]);
    const summary = feedOf(t.store, "assistant")[0] as Extract<FeedItem, { kind: "assistant" }>;
    assert.match(summary.text, /start with `parse_line`/);
    assert.deepStrictEqual(summary.changes?.added, ["parse_line", "count_words", "main", "counter"]);
    assert.strictEqual(summary.mode, "draft");
    assert.deepStrictEqual(t.busy.slice(-1), [undefined], "busy cleared");
    // A first draft can be undone: back to an empty graph.
    assert.strictEqual(t.store.canUndo("/ws/wc.py"), true);
    assert.deepStrictEqual(t.store.undo("/ws/wc.py")?.nodes, []);
  });

  it("asks for a docstring instead of drafting without one", async () => {
    const t = harness(fake);
    t.type("import os\n", 0);
    await t.assistant.draft(t.h);
    assert.strictEqual(fake.chatRequests.length, 0);
    assert.match((feedOf(t.store, "system")[0] as { text: string }).text, /module docstring/);
  });

  it("acts on an instruction, reports a brief summary, and supports undo", async () => {
    const t = harness(fake);
    await t.assistant.draft(t.h);
    await t.assistant.chat(t.h, "Add a helper that returns the top N words.");
    const g = t.store.graph("/ws/wc.py")!;
    assert.ok(g.nodes.some((n) => n.id === "top_n"));
    assert.ok(g.edges.some((e) => e.from === "main" && e.to === "top_n"));
    const feed = t.store.get("/ws/wc.py").feed;
    assert.strictEqual(feed.filter((f) => f.kind === "user").length, 1);
    const reply = feed[feed.length - 1] as Extract<FeedItem, { kind: "assistant" }>;
    assert.strictEqual(reply.mode, "chat");
    assert.match(reply.text, /Added a `top_n` helper/);
    const chatReq = fake.chatRequests.find((r) => /Task: the programmer wrote/.test(systemPrompt(r)))!;
    assert.match(chatReq.messages[chatReq.messages.length - 1].content ?? "", /## Message from the programmer\nAdd a helper/);
    assert.ok(t.store.canUndo("/ws/wc.py"));
    t.store.undo("/ws/wc.py");
    assert.ok(!t.store.graph("/ws/wc.py")!.nodes.some((n) => n.id === "top_n"));
  });

  it("follows the code: statuses update as the programmer types", async () => {
    const t = harness(fake);
    await t.assistant.draft(t.h);
    t.type(DOC + "\ndef parse_line(line: str) -> list[str]:\n    pass\n\ndef count_words(lines):\n    return Counter(w for l in lines for w in parse_line(l))\n", 9);
    await t.assistant.localSync(t.h);
    const g = t.store.graph("/ws/wc.py")!;
    const st = Object.fromEntries(g.nodes.map((n) => [n.id, [n.status, n.line]]));
    assert.deepStrictEqual(st.parse_line, ["stubbed", 2]);
    assert.deepStrictEqual(st.count_words, ["done", 5]);
    assert.deepStrictEqual(st.main, ["planned", undefined]);
  });

  it("stays quiet when a sync finds nothing to change", async () => {
    const t = harness(fake);
    await t.assistant.draft(t.h);
    const before = t.store.get("/ws/wc.py").feed.length;
    await t.assistant.sync(t.h, "after a heartbeat");
    assert.strictEqual(t.store.get("/ws/wc.py").feed.length, before);
    await t.assistant.sync(t.h);
    assert.strictEqual(t.store.get("/ws/wc.py").feed.length, before + 1, "an explicit sync always answers");
  });

  it("heartbeat: Jev's calm verdict does not wake the LLM", async () => {
    const t = harness(fake);
    t.type(DOC + "\ndef parse_line(line):\n    return line.split()\n", 3);
    fake.jev = (req) => ({ body: jevAnswers(req, { interrupt: 0.1, issue: "none", severity: 0 }) });
    const r = await t.heartbeat.beat();
    assert.strictEqual(r?.outcome, "no_action");
    assert.strictEqual(r?.verdict?.source, "jev");
    assert.strictEqual(fake.jevRequests.length, 1);
    assert.strictEqual(fake.chatRequests.length, 0);
    const state = fake.jevRequests[0].body.state as Record<string, unknown>;
    assert.match(String(state.recent_change), /\+ +3 \| def parse_line\(line\):/);
    assert.match(String(state.current_scope_code), /def parse_line/);
    assert.deepStrictEqual(state.cursor, { line: 4, scope: "def parse_line(line)" });
  });

  it("heartbeat: an alarming verdict escalates and the LLM interrupts once", async () => {
    const t = harness(fake);
    const code = DOC + "\ndef parse_line(line: str) -> list[str]:\n    words = line.split()\n    return [w.lowr() for w in words]\n";
    t.type(code, 4);
    fake.jev = (req) => ({ body: jevAnswers(req, { interrupt: 0.92, issue: "typo", severity: 3 }) });
    const r = await t.heartbeat.beat();
    assert.strictEqual(r?.outcome, "interrupted");
    const intr = feedOf(t.store, "interrupt") as Extract<FeedItem, { kind: "interrupt" }>[];
    assert.strictEqual(intr.length, 1);
    assert.strictEqual(intr[0].line, 4);
    assert.strictEqual(intr[0].lineText, "    return [w.lowr() for w in words]");
    assert.strictEqual(intr[0].severity, 3);
    const hbReq = fake.chatRequests.find((q) => /Task: heartbeat check/.test(systemPrompt(q)))!;
    assert.match(hbReq.messages[1].content ?? "", /## Monitor verdict\njev: interrupt 0.92 · typo/);
    assert.match(hbReq.messages[1].content ?? "", />5\| {5}return \[w.lowr\(\)/);
    // The same problem is not raised again on the next beat.
    t.type(code + "\n", 5);
    await t.heartbeat.beat();
    assert.strictEqual(feedOf(t.store, "interrupt").length, 1);
  });

  it("heartbeat: an interrupt flags its graph node until it is resolved", async () => {
    const t = harness(fake);
    await t.assistant.draft(t.h);
    t.type(DOC + "\ndef parse_line(line: str) -> list[str]:\n    words = line.split()\n    return [w.lowr() for w in words]\n", 4);
    fake.jev = (req) => ({ body: jevAnswers(req, { interrupt: 0.92, issue: "typo", severity: 3 }) });
    assert.strictEqual((await t.heartbeat.beat())?.outcome, "interrupted");
    const node = () => t.store.graph("/ws/wc.py")!.nodes.find((n) => n.id === "parse_line")!;
    assert.strictEqual(node().status, "attention");
    assert.strictEqual(node().attention, "Typo in a method name");
    const item = feedOf(t.store, "interrupt")[0] as Extract<FeedItem, { kind: "interrupt" }>;
    await t.assistant.unflag(t.h, item);
    assert.strictEqual(node().status, "done");
    assert.strictEqual(node().attention, undefined);
  });

  it("heartbeat: an interrupt cooldown holds back minor issues", async () => {
    const t = harness(fake);
    t.heartbeat.noteInterrupt("/ws/wc.py");
    t.type(DOC + "x = 1\n", 1);
    fake.jev = (req) => ({ body: jevAnswers(req, { interrupt: 0.9, issue: "better_implementation", severity: 2 }) });
    const r = await t.heartbeat.beat();
    assert.deepStrictEqual(r?.actions, ["interrupt cooldown"]);
    assert.strictEqual(fake.chatRequests.length, 0);
  });

  it("heartbeat: LLM triage works without Jev", async () => {
    const t = harness(fake, "llm");
    t.type(DOC + "\ndef parse_line(line):\n    words = line.split()\n    return [w.lowr() for w in words]\n", 4);
    const r = await t.heartbeat.beat();
    assert.strictEqual(r?.verdict?.source, "llm");
    assert.strictEqual(fake.jevRequests.length, 0);
    assert.strictEqual(r?.outcome, "interrupted");
  });

  it("heartbeat: a Jev failure is reported, not thrown", async () => {
    const t = harness(fake);
    t.type(DOC + "x = 1\n", 1);
    fake.jev = () => ({ status: 401, body: { error: { message: "bad key" } } });
    const r = await t.heartbeat.beat();
    assert.strictEqual(r?.outcome, "error");
    assert.match(r?.error ?? "", /ASSISTIVE_JEV_API_KEY/);
  });

  it("heartbeat timing: beats only after typing, a pause and the interval", async () => {
    const t = harness(fake);
    fake.jev = (req) => ({ body: jevAnswers(req, {}) });
    await t.heartbeat.tick();
    assert.strictEqual(fake.jevRequests.length, 0, "no typing yet");
    t.type(DOC + "x = 1\n", 1);
    await t.heartbeat.tick();
    assert.strictEqual(fake.jevRequests.length, 0, "the programmer is still typing");
  });

  it("queues a message sent during a draft instead of throwing the draft away", async () => {
    const t = harness(fake);
    fake.chatDelayMs = 60;
    const draft = t.assistant.draft(t.h);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(t.assistant.isBusy("/ws/wc.py"));
    const chat = t.assistant.chat(t.h, "Add a helper that returns the top N words.");
    // The message shows at once, before its turn starts.
    assert.strictEqual(feedOf(t.store, "user").length, 1);
    await Promise.all([draft, chat]);
    const ids = t.store.graph("/ws/wc.py")!.nodes.map((n) => n.id);
    assert.deepStrictEqual(ids, ["parse_line", "count_words", "main", "counter", "top_n"], "both turns applied, in order");
    const modes = (feedOf(t.store, "assistant") as Extract<FeedItem, { kind: "assistant" }>[]).map((f) => f.mode);
    assert.deepStrictEqual(modes, ["draft", "chat"]);
    // The chat turn saw the drafted graph.
    const chatReq = fake.chatRequests.find((r) => /Task: the programmer wrote/.test(systemPrompt(r)))!;
    assert.match(chatReq.messages.at(-1)!.content ?? "", /## Graph\nnodes \(4\)/);
    assert.ok(!t.assistant.isBusy("/ws/wc.py"));
  });

  it("the programmer's message cancels a heartbeat turn in progress", async () => {
    const t = harness(fake);
    await t.assistant.draft(t.h);
    t.type(DOC + "\ndef parse_line(line: str) -> list[str]:\n    return [w.lowr() for w in line.split()]\n", 3);
    fake.jev = (req) => ({ body: jevAnswers(req, { interrupt: 0.92, issue: "typo", severity: 3 }) });
    fake.chatDelayMs = 80;
    const beat = t.heartbeat.beat();
    await new Promise((r) => setTimeout(r, 40));
    const chat = t.assistant.chat(t.h, "Add a helper that returns the top N words.");
    const [report] = await Promise.all([beat, chat]);
    assert.strictEqual(report?.outcome, "no_action", "the escalation was cancelled");
    assert.strictEqual(feedOf(t.store, "interrupt").length, 0);
    assert.ok(t.store.graph("/ws/wc.py")!.nodes.some((n) => n.id === "top_n"));
    assert.ok(t.logs.some((l) => l === "heartbeat: cancelled"));
    assert.strictEqual(feedOf(t.store, "system").length, 0, "a preempted heartbeat leaves no note");
  });

  it("Stop cancels a turn, rolls back its live preview and says so", async () => {
    const t = harness(fake);
    fake.chatDelayMs = 60;
    const draft = t.assistant.draft(t.h);
    // Wait until the first tool round has been applied as a live preview.
    for (let i = 0; i < 50 && !t.store.graph("/ws/wc.py")?.nodes.length; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(t.store.graph("/ws/wc.py")?.nodes.length, "the preview is visible");
    t.assistant.cancel("/ws/wc.py");
    await draft;
    assert.strictEqual(t.store.graph("/ws/wc.py"), undefined, "the preview was rolled back");
    assert.match((feedOf(t.store, "system").at(-1) as { text: string }).text, /^Stopped\./);
    assert.ok(!t.assistant.isBusy("/ws/wc.py"));
  });

  it("settle stops the turn and skips the queued ones silently, rolling back before it returns", async () => {
    const t = harness(fake);
    fake.chatDelayMs = 60;
    const draft = t.assistant.draft(t.h);
    for (let i = 0; i < 50 && !t.store.graph("/ws/wc.py")?.nodes.length; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(t.store.graph("/ws/wc.py")?.nodes.length, "the preview is visible");
    const chat = t.assistant.chat(t.h, "Add a helper that returns the top N words.");
    const requests = fake.chatRequests.length;
    await t.assistant.settle("/ws/wc.py");
    assert.strictEqual(t.store.graph("/ws/wc.py"), undefined, "the preview was rolled back before settle returned");
    assert.ok(!t.assistant.isBusy("/ws/wc.py"));
    await Promise.all([draft, chat]);
    assert.ok(fake.chatRequests.length <= requests + 1, "the queued chat never ran");
    assert.ok(!fake.chatRequests.some((r) => /Task: the programmer wrote/.test(systemPrompt(r))), "no chat request was sent");
    assert.strictEqual(feedOf(t.store, "system").length, 0, "no Stopped note");
    // The file works normally afterwards.
    await t.assistant.draft(t.h);
    assert.ok(t.store.graph("/ws/wc.py")?.nodes.length);
  });

  it("dismissed issue kinds follow a renamed file", async () => {
    const t = harness(fake);
    await t.assistant.draft(t.h);
    t.type(DOC + "\ndef parse_line(line: str) -> list[str]:\n    return [w.lowr() for w in line.split()]\n", 3);
    fake.jev = (req) => ({ body: jevAnswers(req, { interrupt: 0.92, issue: "typo", severity: 2 }) });
    t.heartbeat.noteDismissed("/ws/wc.py", "typo");
    t.heartbeat.noteDismissed("/ws/wc.py", "typo");
    t.store.move("/ws/wc.py", "/ws/renamed.py", "renamed.py");
    t.heartbeat.move("/ws/wc.py", "/ws/renamed.py");
    const r = await t.heartbeat.beat({ ...t.h, key: "/ws/renamed.py", file: "renamed.py" });
    assert.strictEqual(r?.outcome, "no_action");
    assert.ok(r?.actions.some((a) => /typo notes were dismissed 2 times/.test(a)), r?.actions.join("; "));
    assert.strictEqual(feedOf(t.store, "interrupt").length, 0);
  });

  it("settle on an idle file returns at once", async () => {
    const t = harness(fake);
    await t.assistant.settle("/ws/wc.py");
    assert.ok(!t.assistant.isBusy("/ws/wc.py"));
  });

  it("a struggle turn can only recommend resources", async () => {
    const t = harness(fake);
    t.type(DOC + "x = 1\n", 1);
    fake.jev = (req) => ({ body: jevAnswers(req, { interrupt: 0.05, issue: "none", severity: 0, struggling: 0.9 }) });
    fake.chat = () => ({ content: "No help needed." });
    const r = await t.heartbeat.beat();
    assert.ok(r?.actions.some((a) => /may be stuck/.test(a)));
    const req = fake.chatRequests[0];
    const tools = (req.tools ?? []).map((x) => x.function.name);
    assert.ok(tools.includes("recommend_resources"));
    assert.ok(!tools.includes("interrupt_programmer") && !tools.includes("update_nodes"));
    assert.strictEqual(t.store.get("/ws/wc.py").feed.length, 0, "'No help needed' posts nothing");
  });

  it("gives chat the code around the cursor, and drafts keep code that exists", async () => {
    const t = harness(fake);
    const code = DOC + "\ndef parse_line(line: str) -> list[str]:\n    return line.split()\n";
    t.type(code, 3);
    await t.assistant.chat(t.h, "Is this right?");
    const chatReq = fake.chatRequests.find((r) => /Task: the programmer wrote/.test(systemPrompt(r)))!;
    assert.match(chatReq.messages.at(-1)!.content ?? "", /## Code around the cursor\n 3\| def parse_line\(line: str\) -> list\[str\]:\n>4\| {5}return line.split\(\)/);
    fake.reset();
    t.store.clear("/ws/wc.py");
    await t.assistant.draft(t.h);
    const draftReq = fake.chatRequests.find((r) => /Task: draft/.test(systemPrompt(r)))!;
    assert.match(draftReq.messages[1].content ?? "", /## Code that exists\nThe file already has code\. Plan a node for each meaningful symbol/);
  });

  it("tells the draft what imported project files plan but have not typed yet", async () => {
    const t = harness(fake);
    (t.h.ws as MemoryWorkspace).files["util.py"] = '"""Text helpers."""\n';
    t.store.setGraph(
      "/ws/util.py",
      {
        file: "util.py",
        language: "python",
        moduleString: "Text helpers.",
        nodes: [
          { id: "tokenize", kind: "function", label: "tokenize", symbol: "tokenize", signature: "def tokenize(text: str) -> list[str]", description: "Split.", notes: [], status: "planned" },
          { id: "re", kind: "external", label: "re", description: "regex", notes: [], status: "planned" },
        ],
        edges: [],
        revision: 1,
        updatedAt: "",
      },
      false,
    );
    t.type(DOC + "import util\n", 1);
    await t.assistant.draft(t.h);
    const draftReq = fake.chatRequests.find((r) => /Task: draft/.test(systemPrompt(r)))!;
    assert.match(draftReq.messages[1].content ?? "", /Imported module util.py — Text helpers\.:\n[\s\S]*Planned in util.py but not typed yet:\n- def tokenize\(text: str\) -> list\[str\]/);
    assert.doesNotMatch(draftReq.messages[1].content ?? "", /- regex/, "externals are not listed");
  });

  it("streams the reply of a programmer turn and clears it at the end", async () => {
    const t = harness(fake);
    await t.assistant.draft(t.h);
    assert.ok(t.streams.some((x) => x?.startsWith("Drafted 3")), "the summary streamed");
    const summary = feedOf(t.store, "assistant")[0] as Extract<FeedItem, { kind: "assistant" }>;
    assert.deepStrictEqual(summary.usage, { prompt: 200, completion: 40 }, "two streamed rounds, usage from each");
    assert.strictEqual(t.streams.at(-1), undefined, "cleared when the turn ended");
    assert.ok(fake.chatRequests.every((q) => q.stream === true));
  });

  it("heartbeat turns do not stream", async () => {
    const t = harness(fake);
    t.type(DOC + "\ndef parse_line(line):\n    return [w.lowr() for w in line.split()]\n", 3);
    fake.jev = (req) => ({ body: jevAnswers(req, { interrupt: 0.92, issue: "typo", severity: 3 }) });
    await t.heartbeat.beat();
    assert.deepStrictEqual(t.streams, []);
    assert.ok(fake.chatRequests.every((q) => q.stream !== true));
  });

  it("automatic beats skip changes that are only whitespace; Check now does not", async () => {
    let clock = 1_000_000;
    const t = harness(fake, "jev", () => clock);
    t.type(DOC + "\n\n   \n", 2);
    clock += 60_000;
    await t.heartbeat.tick();
    assert.strictEqual(t.reports.at(-1)?.outcome, "skipped");
    assert.deepStrictEqual(t.reports.at(-1)?.actions, ["only whitespace changed"]);
    assert.strictEqual(fake.jevRequests.length, 0);
    await t.heartbeat.beat();
    assert.strictEqual(fake.jevRequests.length, 1, "a manual beat always triages");
  });

  it("backs off after repeated triage failures, then recovers", async () => {
    let clock = 1_000_000;
    const t = harness(fake, "jev", () => clock);
    fake.jev = () => ({ status: 500, body: { error: { message: "down" } } });
    const typeAndWait = (n: number) => {
      t.type(DOC + `x = ${n}\n`, 1);
      clock += 50_000; // past the 45 s interval and the 2 s pause
    };
    typeAndWait(1);
    await t.heartbeat.tick();
    assert.strictEqual(fake.jevRequests.length, 1);
    assert.match(t.logs.at(-1)!, /heartbeat failed \(1 in a row, next automatic beat in 90s\)/);
    typeAndWait(2); // 50 s later: still inside the 90 s pause
    await t.heartbeat.tick();
    assert.strictEqual(fake.jevRequests.length, 1, "no request during the pause");
    typeAndWait(3); // 100 s after the failure
    await t.heartbeat.tick();
    assert.strictEqual(fake.jevRequests.length, 2);
    assert.match(t.logs.at(-1)!, /2 in a row, next automatic beat in 180s/);
    fake.jev = (req) => ({ body: jevAnswers(req, {}) });
    clock += 200_000;
    typeAndWait(4);
    await t.heartbeat.tick();
    assert.strictEqual(t.reports.at(-1)?.outcome, "no_action", "recovered");
    clock += 1;
    typeAndWait(5);
    await t.heartbeat.tick();
    assert.strictEqual(fake.jevRequests.length, 4, "no pause after a success");
  });

  it("scopeCode marks the cursor inside the enclosing symbol", async () => {
    const text = DOC + "\ndef f(a):\n    b = a\n    return b\n";
    const o = await outline(ts, "python", text);
    assert.strictEqual(scopeCode(o, text.split("\n"), 3), " 3| def f(a):\n>4|     b = a\n 5|     return b");
  });
});
