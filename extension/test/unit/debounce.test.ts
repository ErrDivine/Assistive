import * as assert from "node:assert";
import { Debouncer } from "../../src/code/debounce";
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
