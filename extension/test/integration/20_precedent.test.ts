// Phase 2/4 in the editor: precedent cards, never the code being edited, history recovery.
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ContextFrame } from "../../src/types";
import { api, FIXTURES, openAt, waitFor, waitIndexed, writeWorkspaceFile } from "./helpers";

const NEAR_COPY = `import requests

DEFAULT_TIMEOUT = 10


def fetch_admins(session, base_url, org):
    """Return the admins of an organisation."""
    resp = session.get("%s/orgs/%s/admins" % (base_url, org), timeout=DEFAULT_TIMEOUT)
    resp.raise_for_status()
    return resp.json()["admins"]
`;

const TSV = `def parse_tsv_line(line, sep="\\t"):
    """Split one TSV line, honouring double quotes."""
    fields, current, quoted = [], [], False
    for ch in line:
        if ch == '"':
            quoted = not quoted
        elif ch == sep and not quoted:
            fields.append("".join(current))
            current = []
        else:
            current.append(ch)
    fields.append("".join(current))
    return fields
`;

describe("Phase 2/4: precedent cards", function () {
  before(async function () {
    this.timeout(300_000);
    await waitIndexed(await api());
  });

  it("writing a function like an existing helper shows that helper as a precedent", async () => {
    const a = await api();
    const file = writeWorkspaceFile("app/rail_it_new_admins.py", NEAR_COPY);
    await openAt(file, 'return resp.json()["admins"]', 4);
    await vscode.commands.executeCommand("referenceRail.askAboutSymbol", "");
    const card = await waitFor(
      () => a.rail.liveCards.find((c) => c.kind === "precedent"),
      15_000,
      "a precedent card",
    );
    assert.ok(card.snippet && card.snippet.text.length > 0);
    assert.ok(card.source.repo, "precedent cards name their repo");
    assert.ok(card.facts.every((f) => f.span.path));
  });

  it("editing a function never shows that same function as a precedent", async () => {
    const a = await api();
    const client = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, "app", "client.py");
    const text = fs.readFileSync(client, "utf8");
    const m = /def (fetch_\w+)\(/.exec(text)!;
    const own = `app.client.${m[1]}`;
    // Cursor on the def line, then inside the body.
    for (const [find, offset] of [[m[0], 6], ["resp.raise_for_status()", 4]] as [string, number][]) {
      await openAt(client, find, offset);
      const frame = (await vscode.commands.executeCommand("referenceRail.askAboutSymbol", "")) as ContextFrame;
      const result = await waitFor(
        () => a.controller.lastResult?.requestId === frame.requestId && a.controller.lastResult,
        15_000,
        "the query result",
      );
      assert.ok(
        !result.cards.some((c) => c.kind === "precedent" && c.qualname === own),
        `${own} was shown as its own precedent`,
      );
    }
  });

  it("a function deleted in the history of an extra repo is found, with a 'deleted in <sha>' badge", async () => {
    const a = await api();
    const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, "fixture_history.json"), "utf8"));
    const deleted = manifest.deleted.find((d: { qualname: string }) => d.qualname === "textutil.parse_csv_line");
    const file = writeWorkspaceFile("app/rail_it_tsv.py", TSV);
    await openAt(file, "fields.append(\"\".join(current))", 8, 2);
    await vscode.commands.executeCommand("referenceRail.askAboutSymbol", "");
    const card = await waitFor(
      () => a.rail.liveCards.find((c) => c.qualname === "textutil.parse_csv_line"),
      15_000,
      "the deleted parse_csv_line",
    );
    assert.strictEqual(card.source.deleted, true);
    assert.strictEqual(card.source.commit, deleted.deleted_in);
    // Open source shows the function as it was before the deleting commit.
    await a.act("open", card);
    const ed = await waitFor(
      () => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "reference-rail-source"),
      10_000,
      "virtual git document",
    );
    assert.ok(ed.document.getText().includes("def parse_csv_line"));
  });
});
