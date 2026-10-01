// Phase 4: Frequent after 3 opens; pins.
import * as assert from "node:assert";
import { api, openAt, waitFor, waitIndexed, writeWorkspaceFile } from "./helpers";

const SAMPLE = `import requests


def ping(url):
    return requests.head(url, timeout=1)
`;

describe("Phase 4: lookup memory", function () {
  before(async function () {
    this.timeout(300_000);
    await waitIndexed(await api());
  });

  it("opening the same API card 3 times makes it appear under Frequent", async () => {
    const a = await api();
    const file = writeWorkspaceFile("rail_it_memory.py", SAMPLE);
    await openAt(file, "requests.head(", 10);
    const card = await waitFor(() => a.rail.liveCards.find((c) => c.title.startsWith("requests.head")), 15_000, "requests.head card");
    for (let i = 0; i < 3; i++) {
      await a.act("open", card);
    }
    a.logger.flush();
    await waitFor(async () => {
      await a.refreshMemory();
      return a.rail.frequentCards.some((c) => c.qualname === card.qualname);
    }, 15_000, "Frequent entry");
    const freq = a.rail.frequentCards.find((c) => c.qualname === card.qualname)!;
    assert.strictEqual(freq.kind, "frequent");
  });

  it("pinning keeps a card in Pinned until unpinned", async () => {
    const a = await api();
    const card = a.rail.liveCards.find((c) => c.title.startsWith("requests.head"))!;
    await a.act("pin", card);
    await waitFor(() => a.rail.pinnedCards.some((c) => c.qualname === card.qualname), 10_000, "pinned card");
    assert.ok(!a.rail.frequentCards.some((c) => c.qualname === card.qualname), "pinned cards leave Frequent");
    const pinned = a.rail.pinnedCards.find((c) => c.qualname === card.qualname)!;
    await a.act("unpin", pinned, "pinned");
    await waitFor(() => !a.rail.pinnedCards.some((c) => c.qualname === card.qualname), 10_000, "unpinned");
  });
});
