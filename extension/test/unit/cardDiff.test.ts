import * as assert from "node:assert";
import {
  cardKey,
  diffCards,
  EMPTY_FADE_MS,
  LiveScheduler,
  MIN_VISIBLE_MS,
  sameCards,
} from "../../src/rail/cardDiff";
import type { Card, Fact, FactLabel } from "../../src/types";
import { FakeClock } from "./fakeClock";

function fact(label: FactLabel, text: string): Fact {
  return { label, text, origin: "docstring", span: { path: "lib.py", startLine: 1, endLine: 2 } };
}

function card(id: string, over: Partial<Card> = {}): Card {
  return {
    id,
    kind: "api",
    title: `title ${id}`,
    facts: [fact("signature", `sig ${id}`), fact("summary", `summary ${id}`)],
    source: { path: "lib.py", startLine: 10, endLine: 20 },
    confidence: 0.5,
    reason: "matches the symbol",
    ...over,
  };
}

const cardsOf = (...ids: string[]): Card[] => ids.map((id) => card(id));
const idsOf = (cards: Card[]): string[] => cards.map((c) => c.id);

describe("cardKey", () => {
  it("is equal for structurally equal cards built separately", () => {
    assert.strictEqual(cardKey(card("a")), cardKey(card("a")));
  });

  it("differs between cards with different ids", () => {
    assert.notStrictEqual(cardKey(card("a")), cardKey(card("b", { title: "title a", facts: card("a").facts })));
  });

  it("changes when the title changes", () => {
    assert.notStrictEqual(cardKey(card("a")), cardKey(card("a", { title: "other" })));
  });

  it("changes when a fact's text, label or position changes", () => {
    const base = card("a");
    assert.notStrictEqual(cardKey(base), cardKey(card("a", { facts: [fact("signature", "changed"), base.facts[1]] })));
    assert.notStrictEqual(cardKey(base), cardKey(card("a", { facts: [fact("note", base.facts[0].text), base.facts[1]] })));
    assert.notStrictEqual(cardKey(base), cardKey(card("a", { facts: [base.facts[1], base.facts[0]] })));
  });

  it("changes when a fact is added or removed", () => {
    const base = card("a");
    assert.notStrictEqual(cardKey(base), cardKey(card("a", { facts: [...base.facts, fact("raises", "ValueError")] })));
    assert.notStrictEqual(cardKey(base), cardKey(card("a", { facts: base.facts.slice(0, 1) })));
    assert.notStrictEqual(cardKey(base), cardKey(card("a", { facts: [] })));
  });

  it("changes when the snippet text changes, appears or disappears", () => {
    const withSnippet = card("a", { snippet: { text: "x = 1", startLine: 3 } });
    assert.notStrictEqual(cardKey(card("a")), cardKey(withSnippet));
    assert.notStrictEqual(cardKey(withSnippet), cardKey(card("a", { snippet: { text: "x = 2", startLine: 3 } })));
  });

  it("changes when stale or pinned flips", () => {
    const base = cardKey(card("a"));
    assert.notStrictEqual(base, cardKey(card("a", { stale: true })));
    assert.notStrictEqual(base, cardKey(card("a", { pinned: true })));
    assert.notStrictEqual(cardKey(card("a", { stale: true })), cardKey(card("a", { pinned: true })));
    assert.notStrictEqual(cardKey(card("a", { stale: true, pinned: true })), cardKey(card("a", { stale: true })));
  });

  it("treats a missing flag and false alike", () => {
    assert.strictEqual(cardKey(card("a")), cardKey(card("a", { stale: false, pinned: false })));
  });

  it("ignores confidence (ordering is carried by list order, not by the key)", () => {
    assert.strictEqual(cardKey(card("a", { confidence: 0.1 })), cardKey(card("a", { confidence: 0.9 })));
  });

  it("does not let adjacent fields run together", () => {
    assert.notStrictEqual(cardKey(card("ab", { title: "c" })), cardKey(card("a", { title: "bc" })));
    assert.notStrictEqual(
      cardKey(card("a", { facts: [fact("note", "xy")] })),
      cardKey(card("a", { facts: [fact("note", "x"), fact("note", "y")] })),
    );
    assert.notStrictEqual(
      cardKey(card("a", { facts: [fact("note", "x"), fact("summary", "y")] })),
      cardKey(card("a", { facts: [fact("note", "x"), fact("param", "y")] })),
    );
  });

  // Possible BUG (src/rail/cardDiff.ts cardKey, lines 7-17). The key promises
  // "an unchanged key means the DOM node can stay as is", but the webview
  // (rail.ts sourceLabel / render) also renders card.reason, source.path,
  // source.startLine, source.deleted + source.commit and authoredAt, none of
  // which are part of the key. A card that keeps its id but gets a new reason
  // or location is classified `keep`, so the stale DOM text stays on screen.
  // Confirm whether that is intentional (anti-flicker) before enabling.
  it("changes when a rendered field outside id/title/facts/snippet changes", () => {
    const base = cardKey(card("a"));
    assert.notStrictEqual(base, cardKey(card("a", { reason: "similar to the current function" })));
    assert.notStrictEqual(base, cardKey(card("a", { source: { path: "lib.py", startLine: 99, endLine: 120 } })));
    assert.notStrictEqual(base, cardKey(card("a", { authoredAt: "2026-01-01T00:00:00Z" })));
  });
});

describe("sameCards", () => {
  it("is true for two empty lists", () => {
    assert.strictEqual(sameCards([], []), true);
  });

  it("is true for equal content in separate objects", () => {
    assert.strictEqual(sameCards(cardsOf("a", "b"), cardsOf("a", "b")), true);
  });

  it("is false when lengths differ", () => {
    assert.strictEqual(sameCards(cardsOf("a"), cardsOf("a", "b")), false);
    assert.strictEqual(sameCards(cardsOf("a", "b"), cardsOf("a")), false);
    assert.strictEqual(sameCards([], cardsOf("a")), false);
  });

  it("is false when the order differs", () => {
    assert.strictEqual(sameCards(cardsOf("a", "b"), cardsOf("b", "a")), false);
  });

  it("is false when the content of one card differs", () => {
    assert.strictEqual(sameCards(cardsOf("a", "b"), [card("a"), card("b", { pinned: true })]), false);
  });

  it("is true when only unrelated fields differ", () => {
    assert.strictEqual(sameCards([card("a", { confidence: 0.2 })], [card("a", { confidence: 0.8 })]), true);
  });
});

describe("diffCards", () => {
  it("empty to empty is a no-op", () => {
    assert.deepStrictEqual(diffCards([], []), { keep: [], create: [], remove: [], order: [] });
  });

  it("unchanged cards are kept, never created or removed", () => {
    const d = diffCards(cardsOf("a", "b", "c"), cardsOf("a", "b", "c"));
    assert.deepStrictEqual(d.keep, ["a", "b", "c"]);
    assert.deepStrictEqual(d.create, []);
    assert.deepStrictEqual(d.remove, []);
    assert.deepStrictEqual(d.order, ["a", "b", "c"]);
  });

  it("everything is created when there was nothing before", () => {
    const next = cardsOf("a", "b");
    const d = diffCards([], next);
    assert.deepStrictEqual(d.keep, []);
    assert.deepStrictEqual(idsOf(d.create), ["a", "b"]);
    assert.strictEqual(d.create[0], next[0], "the very card objects are handed back");
    assert.deepStrictEqual(d.remove, []);
    assert.deepStrictEqual(d.order, ["a", "b"]);
  });

  it("everything is removed when the next list is empty", () => {
    const d = diffCards(cardsOf("a", "b"), []);
    assert.deepStrictEqual(d, { keep: [], create: [], remove: ["a", "b"], order: [] });
  });

  it("a new card is created and the rest kept", () => {
    const d = diffCards(cardsOf("a"), cardsOf("a", "b"));
    assert.deepStrictEqual(d.keep, ["a"]);
    assert.deepStrictEqual(idsOf(d.create), ["b"]);
    assert.deepStrictEqual(d.remove, []);
    assert.deepStrictEqual(d.order, ["a", "b"]);
  });

  it("a dropped card is removed and the rest kept", () => {
    const d = diffCards(cardsOf("a", "b", "c"), cardsOf("a", "c"));
    assert.deepStrictEqual(d.keep, ["a", "c"]);
    assert.deepStrictEqual(d.create, []);
    assert.deepStrictEqual(d.remove, ["b"]);
    assert.deepStrictEqual(d.order, ["a", "c"]);
  });

  it("a replaced card is removed, the new one created", () => {
    const d = diffCards(cardsOf("a", "b"), cardsOf("a", "c"));
    assert.deepStrictEqual(d.keep, ["a"]);
    assert.deepStrictEqual(idsOf(d.create), ["c"]);
    assert.deepStrictEqual(d.remove, ["b"]);
    assert.deepStrictEqual(d.order, ["a", "c"]);
  });

  it("changed content under the same id is removed and recreated, not kept", () => {
    const changed = card("b", { facts: [fact("signature", "sig b v2")] });
    const d = diffCards(cardsOf("a", "b"), [card("a"), changed]);
    assert.deepStrictEqual(d.keep, ["a"]);
    assert.deepStrictEqual(d.create, [changed]);
    assert.deepStrictEqual(d.remove, ["b"]);
    assert.deepStrictEqual(d.order, ["a", "b"]);
  });

  it("a pin toggle recreates just that card", () => {
    const d = diffCards(cardsOf("a", "b"), [card("a", { pinned: true }), card("b")]);
    assert.deepStrictEqual(d.keep, ["b"]);
    assert.deepStrictEqual(idsOf(d.create), ["a"]);
    assert.deepStrictEqual(d.remove, ["a"]);
  });

  it("a card id is never both kept and created", () => {
    const prev = cardsOf("a", "b", "c", "d");
    const next = [card("a"), card("b", { title: "new" }), card("e"), card("d", { stale: true })];
    const d = diffCards(prev, next);
    const keep = new Set(d.keep);
    for (const c of d.create) {
      assert.ok(!keep.has(c.id), `${c.id} is in both keep and create`);
    }
    for (const id of d.remove) {
      assert.ok(!keep.has(id), `${id} is in both keep and remove`);
    }
    assert.deepStrictEqual(d.keep, ["a"]);
    assert.deepStrictEqual(idsOf(d.create), ["b", "e", "d"]);
    assert.deepStrictEqual(d.remove, ["b", "c", "d"]);
  });

  it("a pure reorder keeps every node and only changes the order", () => {
    const d = diffCards(cardsOf("a", "b", "c"), cardsOf("c", "a", "b"));
    assert.deepStrictEqual(d.keep, ["c", "a", "b"]);
    assert.deepStrictEqual(d.create, []);
    assert.deepStrictEqual(d.remove, []);
    assert.deepStrictEqual(d.order, ["c", "a", "b"]);
  });

  it("`order` always equals the ids of the next list; create follows next order, remove follows previous order", () => {
    const prev = cardsOf("p1", "p2", "p3");
    const next = cardsOf("n2", "p2", "n1");
    const d = diffCards(prev, next);
    assert.deepStrictEqual(d.order, ["n2", "p2", "n1"]);
    assert.deepStrictEqual(idsOf(d.create), ["n2", "n1"]);
    assert.deepStrictEqual(d.remove, ["p1", "p3"]);
    assert.deepStrictEqual(d.keep, ["p2"]);
  });
});

interface RenderCall {
  ids: string[];
  fade: boolean;
  at: number;
}

function harness(start = 0, minVisibleMs?: number, fadeMs?: number) {
  const clock = new FakeClock(start);
  const calls: RenderCall[] = [];
  const scheduler = new LiveScheduler(
    (cards, fade) => calls.push({ ids: idsOf(cards), fade, at: clock.now() }),
    clock,
    minVisibleMs,
    fadeMs,
  );
  return { clock, calls, s: scheduler };
}

describe("LiveScheduler", () => {
  it("exports the documented constants", () => {
    assert.strictEqual(MIN_VISIBLE_MS, 1500);
    assert.strictEqual(EMPTY_FADE_MS, 3000);
  });

  describe("first render and no-op updates", () => {
    it("renders the first non-empty update immediately", () => {
      const { calls, s } = harness();
      s.update(cardsOf("A"));
      assert.deepStrictEqual(calls, [{ ids: ["A"], fade: false, at: 0 }]);
      assert.deepStrictEqual(idsOf(s.current), ["A"]);
      assert.strictEqual(s.renders, 1);
    });

    it("identical updates cause no render", () => {
      const { clock, calls, s } = harness();
      s.update(cardsOf("A", "B"));
      s.update(cardsOf("A", "B"));
      clock.advance(10_000);
      s.update(cardsOf("A", "B"));
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(s.renders, 1);
      assert.strictEqual(clock.pendingTimers, 0);
    });

    it("an empty update with nothing shown renders nothing and arms nothing", () => {
      const { clock, calls, s } = harness();
      s.update([]);
      clock.advance(10_000);
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(clock.pendingTimers, 0);
    });
  });

  describe("minimum visible time (1500 ms)", () => {
    it("a card shown at t=0 cannot be replaced before t=1500; the update is deferred", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A"));
      clock.advance(100);
      s.update(cardsOf("B"));
      assert.strictEqual(calls.length, 1, "no render yet");
      assert.deepStrictEqual(idsOf(s.current), ["A"], "A is still on screen");
      clock.advance(1399); // t = 1499
      assert.strictEqual(calls.length, 1);
      clock.advance(1); // t = 1500
      assert.deepStrictEqual(calls[1], { ids: ["B"], fade: false, at: 1500 });
      assert.deepStrictEqual(idsOf(s.current), ["B"]);
      assert.strictEqual(s.renders, 2);
    });

    it("an update exactly 1500 ms after the card appeared is applied immediately", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A"));
      clock.advance(1500);
      s.update(cardsOf("B"));
      assert.deepStrictEqual(calls[1], { ids: ["B"], fade: false, at: 1500 });
      assert.strictEqual(clock.pendingTimers, 0);
    });

    it("an update 1 ms too early is deferred by exactly 1 ms", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A"));
      clock.advance(1499);
      s.update(cardsOf("B"));
      assert.strictEqual(calls.length, 1);
      clock.advance(1);
      assert.deepStrictEqual(calls[1], { ids: ["B"], fade: false, at: 1500 });
    });

    it("works the same when the clock does not start at zero", () => {
      const start = 1_700_000_000_000;
      const { clock, calls, s } = harness(start);
      s.update(cardsOf("A"));
      clock.advance(200);
      s.update(cardsOf("B"));
      clock.advance(1299);
      assert.strictEqual(calls.length, 1);
      clock.advance(1);
      assert.deepStrictEqual(calls[1], { ids: ["B"], fade: false, at: start + 1500 });
    });

    it("20 rapid updates within 1.5 s produce exactly one extra render with the last cards", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A"));
      for (let i = 1; i <= 20; i++) {
        clock.advance(70); // t = 70 ... 1400
        s.update(cardsOf(`X${i}`));
        assert.strictEqual(clock.pendingTimers, 1, "a single deferred timer, re-armed each time");
      }
      assert.strictEqual(calls.length, 1, "nothing rendered during the burst");
      clock.advance(99); // t = 1499
      assert.strictEqual(calls.length, 1);
      clock.advance(1); // t = 1500
      assert.strictEqual(calls.length, 2);
      assert.deepStrictEqual(calls[1], { ids: ["X20"], fade: false, at: 1500 });
      clock.advance(60_000);
      assert.strictEqual(calls.length, 2, "no further renders");
      assert.strictEqual(s.renders, 2);
    });

    it("the latest pending update wins even when earlier ones had more cards", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A"));
      clock.advance(10);
      s.update(cardsOf("B", "C", "D"));
      clock.advance(10);
      s.update(cardsOf("E"));
      clock.advance(2000);
      assert.deepStrictEqual(
        calls.map((c) => c.ids),
        [["A"], ["E"]],
      );
    });

    it("reverting to the cards on screen cancels the pending update", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A"));
      clock.advance(100);
      s.update(cardsOf("B"));
      assert.strictEqual(clock.pendingTimers, 1);
      clock.advance(100);
      s.update(cardsOf("A"));
      assert.strictEqual(clock.pendingTimers, 0);
      clock.advance(10_000);
      assert.strictEqual(calls.length, 1);
    });

    it("cards that are only added are not delayed", () => {
      const { calls, clock, s } = harness(0);
      s.update(cardsOf("A"));
      clock.advance(10);
      s.update(cardsOf("A", "B"));
      assert.deepStrictEqual(calls[1], { ids: ["A", "B"], fade: false, at: 10 });
    });

    it("a pure reorder is not delayed", () => {
      const { calls, clock, s } = harness(0);
      s.update(cardsOf("A", "B"));
      clock.advance(10);
      s.update(cardsOf("B", "A"));
      assert.deepStrictEqual(calls[1], { ids: ["B", "A"], fade: false, at: 10 });
    });

    it("the wait is measured from when each dropped card first appeared", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A")); // A since 0
      clock.advance(1000);
      s.update(cardsOf("A", "B")); // immediate; A keeps since 0, B since 1000
      assert.strictEqual(calls.length, 2);

      clock.advance(200); // t = 1200
      s.update(cardsOf("B")); // drops A (age 1200 -> due at 1500)
      clock.advance(299);
      assert.strictEqual(calls.length, 2);
      clock.advance(1);
      assert.deepStrictEqual(calls[2], { ids: ["B"], fade: false, at: 1500 });
    });

    it("dropping the younger card waits for that card's age", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A"));
      clock.advance(1000);
      s.update(cardsOf("A", "B")); // B since 1000
      clock.advance(200); // t = 1200
      s.update(cardsOf("A")); // drops B -> due at 2500
      clock.advance(1299);
      assert.strictEqual(calls.length, 2);
      clock.advance(1);
      assert.deepStrictEqual(calls[2], { ids: ["A"], fade: false, at: 2500 });
    });

    it("honours custom minVisibleMs", () => {
      const { clock, calls, s } = harness(0, 100);
      s.update(cardsOf("A"));
      clock.advance(10);
      s.update(cardsOf("B"));
      clock.advance(89);
      assert.strictEqual(calls.length, 1);
      clock.advance(1);
      assert.deepStrictEqual(calls[1].ids, ["B"]);
    });
  });

  describe("empty updates and the 3000 ms fade", () => {
    it("does not clear immediately but fades after 3000 ms with render([], true)", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A"));
      clock.advance(100);
      s.update([]);
      assert.strictEqual(calls.length, 1, "nothing rendered yet");
      assert.deepStrictEqual(idsOf(s.current), ["A"], "A stays visible");
      clock.advance(2999); // t = 3099
      assert.strictEqual(calls.length, 1);
      clock.advance(1); // t = 3100
      assert.deepStrictEqual(calls[1], { ids: [], fade: true, at: 3100 });
      assert.deepStrictEqual(s.current, []);
      assert.strictEqual(s.renders, 2);
    });

    it("repeated empty updates do not push the fade out", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A"));
      clock.advance(100);
      s.update([]); // fade due at 3100
      clock.advance(1900);
      s.update([]); // must not re-arm
      clock.advance(1100); // t = 3100
      assert.deepStrictEqual(calls[1], { ids: [], fade: true, at: 3100 });
      assert.strictEqual(calls.length, 2);
      clock.advance(10_000);
      assert.strictEqual(calls.length, 2, "fades once");
    });

    it("a non-empty update before the fade cancels it", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A"));
      clock.advance(100);
      s.update([]); // fade due at 3100
      clock.advance(1900); // t = 2000, A is old enough to be replaced
      s.update(cardsOf("B"));
      assert.deepStrictEqual(calls[1], { ids: ["B"], fade: false, at: 2000 });
      assert.strictEqual(clock.pendingTimers, 0, "fade timer cancelled");
      clock.advance(10_000);
      assert.strictEqual(calls.length, 2, "no fade render");
      assert.deepStrictEqual(idsOf(s.current), ["B"]);
    });

    it("re-sending the cards already on screen also cancels the fade", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A"));
      clock.advance(100);
      s.update([]);
      clock.advance(1900);
      s.update(cardsOf("A"));
      assert.strictEqual(clock.pendingTimers, 0);
      clock.advance(10_000);
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(idsOf(s.current), ["A"]);
    });

    it("a deferred non-empty update before the fade cancels the fade and still honours the 1.5 s rule", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A"));
      clock.advance(100);
      s.update([]); // fade due at 3100
      clock.advance(100);
      s.update(cardsOf("B")); // t = 200: deferred to 1500, fade cancelled
      assert.strictEqual(clock.pendingTimers, 1);
      clock.advance(1300);
      assert.deepStrictEqual(calls[1], { ids: ["B"], fade: false, at: 1500 });
      clock.advance(10_000);
      assert.strictEqual(calls.length, 2);
    });

    it("an empty update discards a pending replacement", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A"));
      clock.advance(100);
      s.update(cardsOf("B")); // pending until 1500
      clock.advance(100);
      s.update([]); // t = 200: drops B, starts the fade (due 3200)
      clock.advance(1400); // t = 1600: B must not appear
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(idsOf(s.current), ["A"]);
      clock.advance(1600); // t = 3200
      assert.deepStrictEqual(calls[1], { ids: [], fade: true, at: 3200 });
      assert.strictEqual(calls.length, 2);
    });

    it("after fading, a new non-empty update renders immediately", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A"));
      s.update([]);
      clock.advance(3000);
      assert.deepStrictEqual(calls[1], { ids: [], fade: true, at: 3000 });
      clock.advance(1);
      s.update(cardsOf("B"));
      assert.deepStrictEqual(calls[2], { ids: ["B"], fade: false, at: 3001 });
    });

    it("honours custom fadeMs", () => {
      const { clock, calls, s } = harness(0, undefined, 500);
      s.update(cardsOf("A"));
      s.update([]);
      clock.advance(499);
      assert.strictEqual(calls.length, 1);
      clock.advance(1);
      assert.deepStrictEqual(calls[1], { ids: [], fade: true, at: 500 });
    });
  });

  describe("remove()", () => {
    it("drops one card immediately, without waiting for the minimum visible time", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A", "B"));
      clock.advance(10);
      s.remove("A");
      assert.deepStrictEqual(calls[1], { ids: ["B"], fade: false, at: 10 });
      assert.deepStrictEqual(idsOf(s.current), ["B"]);
    });

    it("ignores an unknown id", () => {
      const { calls, s } = harness(0);
      s.update(cardsOf("A"));
      s.remove("nope");
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(idsOf(s.current), ["A"]);
    });

    it("removing the last card renders an empty list without fading", () => {
      const { calls, s } = harness(0);
      s.update(cardsOf("A"));
      s.remove("A");
      assert.deepStrictEqual(calls[1], { ids: [], fade: false, at: 0 });
      assert.deepStrictEqual(s.current, []);
    });

    it("on an empty section is a no-op", () => {
      const { calls, s } = harness(0);
      s.remove("A");
      assert.deepStrictEqual(calls, []);
    });

    it("a removed card no longer matters when the next update drops another card", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A", "B"));
      clock.advance(10);
      s.remove("A");
      s.update(cardsOf("C")); // drops B (visible since t = 0) -> due at 1500
      clock.advance(1489);
      assert.strictEqual(calls.length, 2);
      clock.advance(1);
      assert.deepStrictEqual(calls[2], { ids: ["C"], fade: false, at: 1500 });
    });
  });

  describe("refresh()", () => {
    const pin = (id: string) => (c: Card) => (c.id === id ? { ...c, pinned: true } : c);

    it("re-renders with the mapped cards when something changed", () => {
      const { calls, s } = harness(0);
      s.update(cardsOf("A", "B"));
      s.refresh(pin("A"));
      assert.deepStrictEqual(calls[1], { ids: ["A", "B"], fade: false, at: 0 });
      assert.strictEqual(s.current[0].pinned, true);
      assert.strictEqual(s.current[1].pinned, undefined);
      assert.strictEqual(s.renders, 2);
    });

    it("does nothing when the mapping changes nothing", () => {
      const { calls, s } = harness(0);
      s.update(cardsOf("A", "B"));
      s.refresh((c) => c);
      s.refresh((c) => ({ ...c, confidence: 0.99 })); // not part of the key
      assert.strictEqual(calls.length, 1);
    });

    it("does nothing on an empty section", () => {
      const { calls, s } = harness(0);
      s.refresh(pin("A"));
      assert.deepStrictEqual(calls, []);
    });

    it("a following identical update (the refreshed cards) causes no render", () => {
      const { calls, s } = harness(0);
      s.update(cardsOf("A"));
      s.refresh(pin("A"));
      s.update([card("A", { pinned: true })]);
      assert.strictEqual(calls.length, 2);
    });

    it("keeps each card's first-shown time, so refreshing does not extend its protection", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A"));
      clock.advance(1000);
      s.refresh(pin("A")); // re-render at t = 1000
      clock.advance(200);
      s.update(cardsOf("B")); // t = 1200; A has been visible since 0 -> due at 1500
      clock.advance(299);
      assert.strictEqual(calls.length, 2);
      clock.advance(1);
      assert.deepStrictEqual(calls[2], { ids: ["B"], fade: false, at: 1500 });
    });
  });

  describe("dispose()", () => {
    it("cancels a pending replacement", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A"));
      clock.advance(100);
      s.update(cardsOf("B"));
      s.dispose();
      assert.strictEqual(clock.pendingTimers, 0);
      clock.advance(10_000);
      assert.strictEqual(calls.length, 1);
    });

    it("cancels a pending fade", () => {
      const { clock, calls, s } = harness(0);
      s.update(cardsOf("A"));
      s.update([]);
      s.dispose();
      assert.strictEqual(clock.pendingTimers, 0);
      clock.advance(10_000);
      assert.strictEqual(calls.length, 1);
    });

    it("is safe when nothing is pending", () => {
      const { s } = harness(0);
      s.dispose();
      s.dispose();
    });
  });
});
