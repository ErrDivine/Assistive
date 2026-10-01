// Phase 3: one render for 20 rapid frames, typing stress (§10), metrics + CSV.
import * as assert from "node:assert";
import { monitorEventLoopDelay } from "node:perf_hooks";
import * as vscode from "vscode";
import type { ContextFrame } from "../../src/types";
import { reportRows } from "../../src/metrics/csv";
import type { MetricsReport } from "../../src/types";
import { api, openAt, sleep, waitFor, waitIndexed, writeWorkspaceFile } from "./helpers";

const SAMPLE = `import requests
import json


def fetch_profile(url):
    resp = requests.get(url, timeout=3)
    return json.loads(resp.text)
`;

function typed(): Set<string> {
  const g = globalThis as { __railTyped?: Set<string> };
  g.__railTyped ??= new Set();
  return g.__railTyped;
}

describe("Phase 3: flow quality", function () {
  before(async function () {
    this.timeout(300_000);
    await waitIndexed(await api());
  });

  it("sending 20 frames in quick succession produces exactly one render, for the last frame", async () => {
    const a = await api();
    const file = writeWorkspaceFile("rail_it_burst.py", SAMPLE);
    let editor = await openAt(file, "requests.get(", 10);
    const last = await a.collector.buildFrame(editor, "cursor_pause");
    editor = await openAt(file, "json.loads(", 6);
    const other = await a.collector.buildFrame(editor, "cursor_pause");
    // Let the collector's own frame for this cursor position render and settle.
    await waitFor(() => a.rail.liveCards.some((c) => c.title.startsWith("json.loads")), 10_000, "json.loads card");
    await sleep(2000);
    const before = a.rail.liveRenders;
    const frames: ContextFrame[] = [];
    for (let i = 0; i < 20; i++) {
      const base = i === 19 ? last : other;
      frames.push({ ...base, requestId: a.collector.nextRequestId() });
    }
    await Promise.all(frames.map((f) => a.controller.submit(f)));
    await sleep(2500);
    assert.strictEqual(a.rail.liveRenders - before, 1, "exactly one render");
    assert.ok(a.rail.liveCards[0].title.startsWith("requests.get"), "rendered the last frame");
    assert.strictEqual(a.controller.lastResult?.requestId, frames[19].requestId);
  });

  it("typing stress: 10 chars/s, no dropped keystrokes, no extension task over 50 ms", async function () {
    const seconds = Number(process.env.RAIL_STRESS_SECONDS ?? "60");
    this.timeout((seconds + 60) * 1000);
    const a = await api();
    const file = writeWorkspaceFile("rail_it_stress.py", "def stress():\n    text = ''\n");
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    typed().add(doc.uri.toString());
    const line = doc.lineCount - 1;
    editor.selection = new vscode.Selection(line, doc.lineAt(line).text.length, line, doc.lineAt(line).text.length);
    a.collector.maxSyncMs = 0;
    const eld = monitorEventLoopDelay({ resolution: 10 });
    eld.enable();
    const alphabet = "abcdefghij klmnopqrstuvwxyz.()_=";
    let expected = "";
    const n = seconds * 10;
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
      const ch = alphabet[i % alphabet.length];
      const end = doc.lineAt(doc.lineCount - 1).range.end;
      // The test's own typing (excluded from the I1 check).
      await editor.edit((eb) => eb.insert(end, ch), { undoStopBefore: false, undoStopAfter: false });
      expected += ch;
      const due = t0 + (i + 1) * 100;
      await sleep(Math.max(0, due - Date.now()));
    }
    eld.disable();
    const lastLine = doc.lineAt(doc.lineCount - 1).text;
    assert.ok(lastLine.endsWith(expected), "every keystroke landed in order");
    assert.ok(a.collector.maxSyncMs < 50, `extension handler took ${a.collector.maxSyncMs.toFixed(1)} ms`);
    console.log(
      `      typing stress: ${n} keystrokes, max extension handler ${a.collector.maxSyncMs.toFixed(2)} ms, ` +
        `event-loop delay p99 ${(eld.percentile(99) / 1e6).toFixed(1)} ms, max ${(eld.max / 1e6).toFixed(1)} ms`,
    );
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  });

  it("showMetrics displays every MetricsReport field from a seeded event log, and the CSV matches", async () => {
    const a = await api();
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    const hour = 3_600_000;
    const events = [];
    for (let m = 0; m < 8; m++) {
      events.push({ ts: iso(2 * hour - m * 60_000), type: "edit_tick", payload: { railEnabled: true } });
    }
    events.push(
      { ts: iso(2 * hour - 30_000), type: "focus_lost", payload: { debug: false, msSinceLastEdit: 10_000, railEnabled: true } },
      { ts: iso(2 * hour - 90_000), type: "focus_gained" },
      { ts: iso(hour), type: "card_shown", payload: { kind: "api" } },
      { ts: iso(hour), type: "card_opened", payload: { kind: "api" } },
    );
    a.server.rail!.logEvents(events);
    await sleep(300);
    const out = (await vscode.commands.executeCommand("referenceRail.showMetrics")) as {
      report: MetricsReport;
      csv: string;
    };
    const r = out.report;
    for (const key of [
      "sinceDays", "generatedAt", "activeHours", "externalLookups", "lookupsPerActiveHour",
      "cardsShown", "cardsOpened", "cardsPinned", "cardsDismissed", "byKind", "latencyP50Ms",
      "latencyP95Ms", "queries", "emptyRateByTrigger",
    ]) {
      assert.ok(key in r, `report has ${key}`);
    }
    assert.ok(r.activeHours >= 1);
    assert.ok(r.externalLookups >= 1);
    assert.ok(r.queries > 0, "queries from this session were logged by the server");
    const csvRows = out.csv.trim().split("\n").slice(1).map((l) => l.split(","));
    const expected = reportRows(r).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)]);
    assert.deepStrictEqual(csvRows, expected);
  });
});

describe("Phase 6: session recording", () => {
  it("records frames and results to ~/.reference-rail/sessions/*.jsonl when recordSessions is on", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(process.env.REFERENCE_RAIL_HOME!, "sessions");
    const files = await waitFor(() => fs.existsSync(dir) && fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")), 5000, "session file");
    assert.ok(files.length > 0);
    const lines = fs.readFileSync(path.join(dir, files[0]), "utf8").trim().split("\n");
    const rec = JSON.parse(lines[lines.length - 1]);
    assert.ok(rec.frame && typeof rec.frame.requestId === "number" && Array.isArray(rec.cards));
  });
});
