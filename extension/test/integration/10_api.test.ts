// Phase 1 acceptance: API cards for requests.get (version + open source) and dict.get (runtime_doc).
import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Card } from "../../src/types";
import {
  api,
  installedVersion,
  lineOf,
  openAt,
  sitePackagesFile,
  sleep,
  waitFor,
  waitIndexed,
  writeWorkspaceFile,
} from "./helpers";

const SAMPLE = `import requests
import json


def fetch_profile(url):
    d: dict = {}
    resp = requests.get(url, timeout=3)
    value = d.get("name")
    return json.loads(resp.text), value
`;

async function cardFor(predicate: (c: Card) => boolean, what: string): Promise<Card> {
  const a = await api();
  return waitFor(() => a.rail.liveCards.find(predicate), 15_000, what);
}

describe("Phase 1: API cards", function () {
  let sample: string;

  before(async function () {
    this.timeout(300_000);
    sample = writeWorkspaceFile("rail_it_sample.py", SAMPLE);
    await waitIndexed(await api());
  });

  it("cursor on requests.get shows a card whose version matches pip show, and Open lands on def get", async () => {
    const a = await api();
    const version = installedVersion("requests");
    await openAt(sample, "requests.get(", 10);
    const card = await cardFor((c) => c.title.startsWith("requests.get"), "requests.get card");
    assert.strictEqual(card.title, `requests.get · requests ${version}`);
    assert.strictEqual(card.source.distVersion, version);
    assert.ok(card.facts.every((f) => f.span && f.span.path), "every fact carries a SourceRef (I2)");
    await a.act("open", card);
    const editor = await waitFor(
      () => {
        const e = vscode.window.visibleTextEditors.find((ed) =>
          ed.document.uri.fsPath.endsWith(path.join("requests", "api.py")),
        );
        return e;
      },
      10_000,
      "requests/api.py editor",
    );
    const defLine = lineOf(sitePackagesFile(path.join("requests", "api.py")), "def get(");
    assert.strictEqual(editor.selection.active.line, defLine);
    // preserveFocus: the user's editor keeps focus.
    assert.ok(vscode.window.activeTextEditor?.document.uri.fsPath.endsWith("rail_it_sample.py"));
  });

  it("cursor on d.get where d: dict shows a runtime_doc card for dict.get", async () => {
    await openAt(sample, "d.get(", 3);
    const card = await cardFor((c) => c.title.startsWith("dict.get"), "dict.get card");
    assert.ok(card.source.runtime, "runtime source");
    assert.ok(card.facts.length > 0);
    assert.ok(card.facts.every((f) => f.origin === "runtime_doc"));
  });

  it("a cursor on nothing resolvable shows no new card (precision over recall)", async () => {
    const a = await api();
    await openAt(sample, "value = d", 1);
    await sleep(1200);
    assert.ok(!a.rail.liveCards.some((c) => c.title.startsWith("value")));
  });
});
