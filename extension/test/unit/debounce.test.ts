import * as assert from "node:assert";
import { Debouncer, fitLines, Ring } from "../../src/context/debounce";
import { FakeClock } from "./fakeClock";

// The delays ContextCollector uses (CURSOR/EDIT/DIAGNOSTIC_DEBOUNCE_MS).
const COLLECTOR_DELAYS: [string, number][] = [
  ["cursor", 350],
  ["edit", 800],
  ["diagnostic", 300],
];

describe("Debouncer", () => {
  let clock: FakeClock;

  beforeEach(() => {
    clock = new FakeClock();
  });

  for (const [name, delay] of COLLECTOR_DELAYS) {
    describe(`${name} delay (${delay} ms)`, () => {
      it("fires once, exactly delayMs after the trigger", () => {
        const d = new Debouncer(delay, clock);
        let calls = 0;
        d.trigger(() => calls++);
        clock.advance(delay - 1);
        assert.strictEqual(calls, 0);
        clock.advance(1);
        assert.strictEqual(calls, 1);
        clock.advance(10 * delay);
        assert.strictEqual(calls, 1, "must not fire again");
      });

      it("fires delayMs after the LAST trigger, not the first", () => {
        const d = new Debouncer(delay, clock);
        const fired: number[] = [];
        d.trigger(() => fired.push(clock.now()));
        clock.advance(delay - 50);
        d.trigger(() => fired.push(clock.now()));
        clock.advance(delay - 50);
        d.trigger(() => fired.push(clock.now()));
        const lastTriggerAt = clock.now();
        clock.advance(delay - 1);
        assert.deepStrictEqual(fired, [], "nothing fires while re-triggered inside the window");
        clock.advance(1);
        assert.deepStrictEqual(fired, [lastTriggerAt + delay]);
      });
    });
  }

  it("exposes delayMs", () => {
    assert.strictEqual(new Debouncer(350, clock).delayMs, 350);
  });

  it("re-triggering replaces the earlier callback", () => {
    const d = new Debouncer(350, clock);
    const calls: string[] = [];
    d.trigger(() => calls.push("first"));
    clock.advance(100);
    d.trigger(() => calls.push("second"));
    clock.advance(1000);
    assert.deepStrictEqual(calls, ["second"]);
  });

  it("a burst of triggers produces a single call", () => {
    const d = new Debouncer(350, clock);
    let calls = 0;
    for (let i = 0; i < 50; i++) {
      d.trigger(() => calls++);
      clock.advance(10);
    }
    assert.strictEqual(calls, 0);
    clock.advance(350);
    assert.strictEqual(calls, 1);
  });

  it("keeps at most one timer armed", () => {
    const d = new Debouncer(350, clock);
    d.trigger(() => undefined);
    d.trigger(() => undefined);
    d.trigger(() => undefined);
    assert.strictEqual(clock.pendingTimers, 1);
  });

  it("cancel() prevents the callback from firing", () => {
    const d = new Debouncer(800, clock);
    let calls = 0;
    d.trigger(() => calls++);
    clock.advance(799);
    d.cancel();
    clock.advance(10_000);
    assert.strictEqual(calls, 0);
    assert.strictEqual(clock.pendingTimers, 0);
  });

  it("cancel() on an idle debouncer is a harmless no-op", () => {
    const d = new Debouncer(300, clock);
    d.cancel();
    assert.strictEqual(d.pending, false);
    d.trigger(() => undefined);
    d.cancel();
    d.cancel();
    assert.strictEqual(d.pending, false);
  });

  it("can be triggered again after cancel() and after firing", () => {
    const d = new Debouncer(300, clock);
    let calls = 0;
    d.trigger(() => calls++);
    d.cancel();
    d.trigger(() => calls++);
    clock.advance(300);
    assert.strictEqual(calls, 1);
    d.trigger(() => calls++);
    clock.advance(300);
    assert.strictEqual(calls, 2);
  });

  it("pending reflects armed / fired / cancelled state", () => {
    const d = new Debouncer(350, clock);
    assert.strictEqual(d.pending, false);
    d.trigger(() => undefined);
    assert.strictEqual(d.pending, true);
    clock.advance(349);
    assert.strictEqual(d.pending, true);
    clock.advance(1);
    assert.strictEqual(d.pending, false);
    d.trigger(() => undefined);
    assert.strictEqual(d.pending, true);
    d.cancel();
    assert.strictEqual(d.pending, false);
  });

  it("pending is already false while the callback runs, and the callback may re-arm", () => {
    const d = new Debouncer(300, clock);
    const seen: boolean[] = [];
    let runs = 0;
    const fn = (): void => {
      runs++;
      seen.push(d.pending);
      if (runs < 3) {
        d.trigger(fn);
      }
    };
    d.trigger(fn);
    clock.advance(300);
    assert.deepStrictEqual(seen, [false]);
    assert.strictEqual(d.pending, true, "re-armed from inside the callback");
    clock.advance(600);
    assert.strictEqual(runs, 3);
    assert.strictEqual(d.pending, false);
  });

  it("independent debouncers do not affect each other", () => {
    const cursor = new Debouncer(350, clock);
    const edit = new Debouncer(800, clock);
    const log: string[] = [];
    cursor.trigger(() => log.push("cursor"));
    edit.trigger(() => log.push("edit"));
    clock.advance(350);
    assert.deepStrictEqual(log, ["cursor"]);
    cursor.trigger(() => log.push("cursor2")); // due at t = 700
    clock.advance(449);
    assert.deepStrictEqual(log, ["cursor", "cursor2"]);
    clock.advance(1); // t = 800
    assert.deepStrictEqual(log, ["cursor", "cursor2", "edit"]);
  });
});

describe("Ring", () => {
  it("keeps everything while below capacity", () => {
    const r = new Ring<number>(3);
    assert.deepStrictEqual(r.toArray(), []);
    r.push(1);
    r.push(2);
    assert.deepStrictEqual(r.toArray(), [1, 2]);
  });

  it("keeps exactly capacity items at the boundary", () => {
    const r = new Ring<number>(3);
    [1, 2, 3].forEach((n) => r.push(n));
    assert.deepStrictEqual(r.toArray(), [1, 2, 3]);
  });

  it("drops the oldest items first once over capacity", () => {
    const r = new Ring<number>(3);
    [1, 2, 3, 4].forEach((n) => r.push(n));
    assert.deepStrictEqual(r.toArray(), [2, 3, 4]);
    [5, 6, 7, 8].forEach((n) => r.push(n));
    assert.deepStrictEqual(r.toArray(), [6, 7, 8]);
  });

  it("holds the last 10 of 25 pushes, in order (the collector's recent-edit ring)", () => {
    const r = new Ring<number>(10);
    for (let i = 0; i < 25; i++) {
      r.push(i);
    }
    assert.deepStrictEqual(r.toArray(), [15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  });

  it("capacity 1 keeps only the latest item", () => {
    const r = new Ring<string>(1);
    r.push("a");
    r.push("b");
    assert.deepStrictEqual(r.toArray(), ["b"]);
  });

  it("capacity 0 keeps nothing", () => {
    const r = new Ring<string>(0);
    r.push("a");
    assert.deepStrictEqual(r.toArray(), []);
  });

  it("toArray returns a copy", () => {
    const r = new Ring<number>(3);
    r.push(1);
    const copy = r.toArray();
    copy.push(99);
    copy[0] = -1;
    assert.deepStrictEqual(r.toArray(), [1]);
  });

  it("clear empties the ring and it can be refilled", () => {
    const r = new Ring<number>(2);
    r.push(1);
    r.push(2);
    r.clear();
    assert.deepStrictEqual(r.toArray(), []);
    r.push(3);
    assert.deepStrictEqual(r.toArray(), [3]);
  });

  it("stores objects by reference", () => {
    const r = new Ring<{ n: number }>(2);
    const o = { n: 1 };
    r.push(o);
    assert.strictEqual(r.toArray()[0], o);
  });
});

describe("fitLines", () => {
  const bytes = (lines: string[], lo: number, hi: number): number =>
    lines.slice(lo, hi + 1).reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);
  /** n lines of exactly 9 ASCII chars, i.e. 10 bytes each with the newline. */
  const tenByteLines = (n: number): string[] => Array.from({ length: n }, (_, i) => String(i).padStart(9, "x"));

  it("empty input yields the empty inclusive range [0, -1]", () => {
    assert.deepStrictEqual(fitLines([], 0), [0, -1]);
    assert.deepStrictEqual(fitLines([], 5, 100), [0, -1]);
  });

  it("returns everything when it all fits", () => {
    const lines = ["a", "b", "c"];
    assert.deepStrictEqual(fitLines(lines, 1), [0, 2]);
  });

  it("a single-line input returns that line", () => {
    assert.deepStrictEqual(fitLines(["only"], 0), [0, 0]);
  });

  it("counts one newline byte per line", () => {
    const lines = tenByteLines(10);
    assert.deepStrictEqual(fitLines(lines, 5, 30), [4, 6], "30 bytes = exactly 3 lines of 10");
    const [lo, hi] = fitLines(lines, 5, 29);
    assert.strictEqual(hi - lo + 1, 2, "29 bytes fits only 2 lines of 10");
  });

  it("counts UTF-8 bytes, not characters", () => {
    // "é" = 2 bytes, "日" = 3, "😀" = 4 (a surrogate pair, 2 UTF-16 code units).
    const lines = ["é", "日", "😀", "x"];
    // sizes with the newline: 3, 4, 5, 2; the cursor is on the 5-byte line.
    assert.deepStrictEqual(fitLines(lines, 2, 5), [2, 2], "the cursor line alone is exactly the budget");
    assert.deepStrictEqual(fitLines(lines, 2, 7), [2, 3], "5 + 2 = 7 (the ASCII line below)");
    assert.deepStrictEqual(fitLines(lines, 2, 9), [1, 2], "5 + 4 = 9 (the 3-byte-char line above)");
    assert.deepStrictEqual(fitLines(lines, 2, 12), [1, 3], "4 + 5 + 2 = 11 fits, 3 + 4 + 5 + 2 = 14 does not");
    assert.deepStrictEqual(fitLines(lines, 2, 14), [0, 3], "all four lines");
  });

  it("keeps the cursor line and never exceeds maxBytes (multi-byte content)", () => {
    const lines = ["日本語のコメント", "def f(é):", "    return '😀'", "# 終わり", "x = 1"];
    for (let max = 1; max < 120; max++) {
      for (let cur = 0; cur < lines.length; cur++) {
        const [lo, hi] = fitLines(lines, cur, max);
        assert.ok(lo <= cur && cur <= hi, `cursor ${cur} inside [${lo},${hi}] for max ${max}`);
        if (lo !== hi) {
          assert.ok(bytes(lines, lo, hi) <= max, `[${lo},${hi}] is ${bytes(lines, lo, hi)} bytes, max ${max}`);
        }
      }
    }
  });

  it("grows in both directions around the cursor", () => {
    const lines = tenByteLines(11);
    // cursor (10) -> up (20) -> down (30) -> up (40) -> down (50)
    assert.deepStrictEqual(fitLines(lines, 5, 50), [3, 7]);
    assert.deepStrictEqual(fitLines(lines, 5, 30), [4, 6]);
  });

  it("prefers growing upward (the def header) when the budget allows an odd number of extra lines", () => {
    const lines = tenByteLines(11);
    assert.deepStrictEqual(fitLines(lines, 5, 20), [4, 5]);
    assert.deepStrictEqual(fitLines(lines, 5, 40), [3, 6]);
  });

  it("keeps growing downward when the top of the file is reached", () => {
    const lines = tenByteLines(10);
    assert.deepStrictEqual(fitLines(lines, 0, 50), [0, 4]);
    assert.deepStrictEqual(fitLines(lines, 1, 50), [0, 4]);
  });

  it("keeps growing upward when the bottom of the file is reached", () => {
    const lines = tenByteLines(10);
    assert.deepStrictEqual(fitLines(lines, 9, 50), [5, 9]);
    assert.deepStrictEqual(fitLines(lines, 8, 50), [5, 9]);
  });

  it("a too-large neighbour blocks that direction but not the other", () => {
    const huge = "y".repeat(500);
    const lines = [...tenByteLines(3), huge, "cursor", ...tenByteLines(3)];
    // huge is at index 3, the cursor at 4: upward is blocked, downward continues.
    const [lo, hi] = fitLines(lines, 4, 100);
    assert.strictEqual(lo, 4);
    assert.strictEqual(hi, 7, "7 (cursor) + 10 + 10 + 10 = 37 bytes, then the end");
    assert.ok(bytes(lines, lo, hi) <= 100);
  });

  it("does not leap over an oversized line to reach lines beyond it", () => {
    const lines = ["a", "b", "z".repeat(200), "c", "d"];
    assert.deepStrictEqual(fitLines(lines, 3, 50), [3, 4]);
    assert.deepStrictEqual(fitLines(lines, 1, 50), [0, 1]);
  });

  it("a cursor line larger than the budget is returned alone", () => {
    const lines = ["a", "b".repeat(100), "c"];
    assert.deepStrictEqual(fitLines(lines, 1, 50), [1, 1]);
  });

  it("a cursor line whose size equals the budget is returned alone (no room for more)", () => {
    const lines = ["a", "b".repeat(9), "c"];
    assert.deepStrictEqual(fitLines(lines, 1, 10), [1, 1]);
  });

  it("a cursor line one byte over the budget is still returned alone", () => {
    const lines = ["a", "b".repeat(10), "c"];
    assert.deepStrictEqual(fitLines(lines, 1, 10), [1, 1]);
  });

  it("an empty cursor line costs one byte (just the newline)", () => {
    const lines = ["", "", "", "", ""];
    assert.deepStrictEqual(fitLines(lines, 2, 3), [1, 3]);
  });

  it("maxBytes 0 still returns the cursor line", () => {
    assert.deepStrictEqual(fitLines(["abc", "def"], 1, 0), [1, 1]);
  });

  it("clamps an out-of-range cursor index into the lines", () => {
    const lines = ["a", "b", "c"];
    assert.deepStrictEqual(fitLines(lines, 100, 2), [2, 2]);
    assert.deepStrictEqual(fitLines(lines, -7, 2), [0, 0]);
  });

  it("defaults to a 4096-byte budget", () => {
    const lines = tenByteLines(1000);
    const [lo, hi] = fitLines(lines, 500);
    assert.strictEqual(bytes(lines, lo, hi), 4090, "409 lines of 10 bytes");
    assert.strictEqual(hi - lo + 1, 409);
    assert.ok(lo <= 500 && 500 <= hi);
  });

  it("result is maximal: no neighbouring line would still fit", () => {
    // Deterministic pseudo-random line lengths (LCG), mixed ASCII / multi-byte.
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };
    const lines = Array.from({ length: 60 }, () => "ab日é".repeat(rnd(12)).slice(0, rnd(40)));
    for (const max of [40, 100, 333, 1024]) {
      for (let cur = 0; cur < lines.length; cur += 7) {
        const [lo, hi] = fitLines(lines, cur, max);
        assert.ok(lo <= cur && cur <= hi);
        const total = bytes(lines, lo, hi);
        if (lo !== hi) {
          assert.ok(total <= max, `total ${total} <= ${max}`);
        }
        if (lo > 0 && total <= max) {
          assert.ok(total + bytes(lines, lo - 1, lo - 1) > max, "line above would not fit");
        }
        if (hi < lines.length - 1 && total <= max) {
          assert.ok(total + bytes(lines, hi + 1, hi + 1) > max, "line below would not fit");
        }
      }
    }
  });
});
