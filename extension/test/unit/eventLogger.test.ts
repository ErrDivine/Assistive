import * as assert from "node:assert";
import { EventLogger, FLUSH_MS } from "../../src/telemetry/EventLogger";
import type { RailEvent } from "../../src/types";
import { FakeClock } from "./fakeClock";

// 2026-10-01T12:00:00.000Z, an exact minute boundary.
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

describe("EventLogger", () => {
  let clock: FakeClock;
  let batches: RailEvent[][];
  let railEnabled: boolean;
  let logger: EventLogger;

  beforeEach(() => {
    clock = new FakeClock(T0);
    batches = [];
    railEnabled = true;
    logger = new EventLogger(
      (events) => {
        batches.push(events);
      },
      () => railEnabled,
      clock,
    );
  });

  it("flushes after 2000 ms", () => {
    assert.strictEqual(FLUSH_MS, 2000);
    logger.log("card_shown", { cardId: "c1" });
    clock.advance(1999);
    assert.strictEqual(batches.length, 0);
    assert.strictEqual(logger.pending, 1);
    clock.advance(1);
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(logger.pending, 0);
  });

  it("nothing is sent when nothing was logged", () => {
    clock.advance(60_000);
    assert.strictEqual(batches.length, 0);
    assert.strictEqual(clock.pendingTimers, 0);
  });

  it("stamps each event with an ISO timestamp from the clock, plus type and fields", () => {
    logger.log("card_shown", { cardId: "c1", qualname: "pkg.fn", trigger: "hover", payload: { n: 1 } });
    clock.advance(500);
    logger.log("card_opened");
    clock.advance(FLUSH_MS);
    assert.deepStrictEqual(batches, [
      [
        {
          ts: iso(T0),
          type: "card_shown",
          cardId: "c1",
          qualname: "pkg.fn",
          trigger: "hover",
          payload: { n: 1 },
        },
        { ts: iso(T0 + 500), type: "card_opened" },
      ],
    ]);
  });

  describe("batching", () => {
    it("events logged within the window go out together in one sink call, in order", () => {
      logger.log("a");
      clock.advance(500);
      logger.log("b");
      clock.advance(1000);
      logger.log("c");
      clock.advance(499);
      assert.strictEqual(batches.length, 0);
      clock.advance(1); // 2000 ms after the first event
      assert.strictEqual(batches.length, 1);
      assert.deepStrictEqual(
        batches[0].map((e) => e.type),
        ["a", "b", "c"],
      );
    });

    it("the timer is armed by the first event and not re-armed by later ones", () => {
      logger.log("a");
      clock.advance(1900);
      logger.log("b"); // would be flushed at 3900 if the timer were re-armed
      clock.advance(100);
      assert.strictEqual(batches.length, 1);
      assert.deepStrictEqual(
        batches[0].map((e) => e.type),
        ["a", "b"],
      );
      assert.strictEqual(clock.pendingTimers, 0);
    });

    it("keeps a single timer armed however many events arrive", () => {
      for (let i = 0; i < 50; i++) {
        logger.log("e");
      }
      assert.strictEqual(clock.pendingTimers, 1);
      assert.strictEqual(logger.pending, 50);
    });

    it("a new batch starts after each flush", () => {
      logger.log("a");
      clock.advance(2000);
      logger.log("b");
      logger.log("c");
      clock.advance(1999);
      assert.strictEqual(batches.length, 1);
      clock.advance(1);
      assert.strictEqual(batches.length, 2);
      assert.deepStrictEqual(
        batches.map((b) => b.map((e) => e.type)),
        [["a"], ["b", "c"]],
      );
    });

    it("honours a custom flush interval", () => {
      const sent: RailEvent[][] = [];
      const fast = new EventLogger((e) => sent.push(e), () => true, clock, 100);
      fast.log("x");
      clock.advance(99);
      assert.strictEqual(sent.length, 0);
      clock.advance(1);
      assert.strictEqual(sent.length, 1);
    });
  });

  describe("flush()", () => {
    it("sends the pending events immediately, in a single call", () => {
      logger.log("a");
      logger.log("b");
      logger.flush();
      assert.strictEqual(batches.length, 1);
      assert.deepStrictEqual(
        batches[0].map((e) => e.type),
        ["a", "b"],
      );
      assert.strictEqual(logger.pending, 0);
    });

    it("cancels the scheduled flush so nothing is sent twice", () => {
      logger.log("a");
      logger.flush();
      assert.strictEqual(clock.pendingTimers, 0);
      clock.advance(10_000);
      assert.strictEqual(batches.length, 1);
    });

    it("is a no-op with an empty queue", () => {
      logger.flush();
      logger.flush();
      assert.strictEqual(batches.length, 0);
    });

    it("events logged after a flush get their own timer and batch", () => {
      logger.log("a");
      clock.advance(1000);
      logger.flush();
      logger.log("b");
      clock.advance(1999);
      assert.strictEqual(batches.length, 1);
      clock.advance(1);
      assert.deepStrictEqual(
        batches.map((b) => b.map((e) => e.type)),
        [["a"], ["b"]],
      );
    });

    it("hands the sink its own array, not the live queue", () => {
      logger.log("a");
      logger.flush();
      logger.log("b");
      assert.deepStrictEqual(
        batches[0].map((e) => e.type),
        ["a"],
        "a later log must not mutate a delivered batch",
      );
    });
  });

  describe("noteEdit()", () => {
    const flushedTicks = (): RailEvent[] => batches.flat().filter((e) => e.type === "edit_tick");

    it("emits an edit_tick with {railEnabled} on the first edit", () => {
      logger.noteEdit();
      logger.flush();
      assert.deepStrictEqual(flushedTicks(), [{ ts: iso(T0), type: "edit_tick", payload: { railEnabled: true } }]);
    });

    it("reports railEnabled false when the rail is paused", () => {
      railEnabled = false;
      logger.noteEdit();
      logger.flush();
      assert.deepStrictEqual(flushedTicks()[0].payload, { railEnabled: false });
    });

    it("reads railEnabled at the time of the tick", () => {
      logger.noteEdit();
      railEnabled = false;
      clock.advance(60_000);
      logger.noteEdit();
      logger.flush();
      assert.deepStrictEqual(
        flushedTicks().map((e) => e.payload),
        [{ railEnabled: true }, { railEnabled: false }],
      );
    });

    it("emits at most one tick per wall-clock minute", () => {
      for (let i = 0; i < 100; i++) {
        logger.noteEdit();
        clock.advance(500); // 100 edits over 50 s: all inside minute 0
      }
      logger.flush();
      assert.strictEqual(flushedTicks().length, 1);
    });

    it("emits again as soon as the wall-clock minute changes", () => {
      logger.noteEdit(); // T0 + 0 s
      clock.advance(59_999);
      logger.noteEdit(); // T0 + 59.999 s: same minute
      clock.advance(1);
      logger.noteEdit(); // T0 + 60 s: next minute
      logger.noteEdit();
      logger.flush();
      assert.deepStrictEqual(
        flushedTicks().map((e) => e.ts),
        [iso(T0), iso(T0 + 60_000)],
      );
    });

    it("uses wall-clock minutes, not 60 s since the previous tick", () => {
      clock = new FakeClock(T0 + 30_000); // :30 into the minute
      const sent: RailEvent[][] = [];
      const l = new EventLogger((e) => sent.push(e), () => true, clock);
      l.noteEdit();
      clock.advance(30_000); // only 30 s later, but it is the next minute
      l.noteEdit();
      l.flush();
      assert.strictEqual(sent.flat().filter((e) => e.type === "edit_tick").length, 2);
    });

    it("a long gap yields a single tick, not one per missed minute", () => {
      logger.noteEdit();
      clock.advance(10 * 60_000);
      logger.noteEdit();
      logger.noteEdit();
      logger.flush();
      assert.strictEqual(flushedTicks().length, 2);
    });

    it("ticks at clock time 0 (minute 0) too", () => {
      clock = new FakeClock(0);
      const sent: RailEvent[][] = [];
      const l = new EventLogger((e) => sent.push(e), () => true, clock);
      l.noteEdit();
      l.flush();
      assert.strictEqual(sent.flat().length, 1);
    });

    it("ticks are batched together with other events", () => {
      logger.log("card_shown");
      logger.noteEdit();
      clock.advance(FLUSH_MS);
      assert.strictEqual(batches.length, 1);
      assert.deepStrictEqual(
        batches[0].map((e) => e.type),
        ["card_shown", "edit_tick"],
      );
    });
  });

  describe("dispose()", () => {
    it("flushes what is pending, then ignores further events", () => {
      logger.log("a");
      logger.dispose();
      assert.strictEqual(batches.length, 1);
      assert.deepStrictEqual(
        batches[0].map((e) => e.type),
        ["a"],
      );
      logger.log("b");
      logger.noteEdit();
      assert.strictEqual(logger.pending, 0);
      assert.strictEqual(clock.pendingTimers, 0, "no timer is armed after dispose");
      clock.advance(10_000);
      logger.flush();
      assert.strictEqual(batches.length, 1, "nothing more reaches the sink");
    });

    it("drops events logged after dispose even across minutes", () => {
      logger.dispose();
      logger.noteEdit();
      clock.advance(5 * 60_000);
      logger.noteEdit();
      logger.log("x");
      logger.flush();
      assert.deepStrictEqual(batches, []);
    });

    it("cancels the scheduled flush", () => {
      logger.log("a");
      logger.dispose();
      assert.strictEqual(clock.pendingTimers, 0);
      clock.advance(10_000);
      assert.strictEqual(batches.length, 1);
    });

    it("on a logger with nothing queued sends nothing", () => {
      logger.dispose();
      assert.deepStrictEqual(batches, []);
    });

    it("can be called twice", () => {
      logger.log("a");
      logger.dispose();
      logger.dispose();
      assert.strictEqual(batches.length, 1);
    });
  });

  describe("sink failures", () => {
    it("exceptions from the sink are swallowed by flush()", () => {
      const bad = new EventLogger(
        () => {
          throw new Error("server is down");
        },
        () => true,
        clock,
      );
      bad.log("a");
      assert.doesNotThrow(() => bad.flush());
      assert.strictEqual(bad.pending, 0, "the failed batch is dropped, not retried forever");
    });

    it("exceptions from the sink are swallowed when the timer fires", () => {
      const bad = new EventLogger(
        () => {
          throw new Error("server is down");
        },
        () => true,
        clock,
      );
      bad.log("a");
      assert.doesNotThrow(() => clock.advance(FLUSH_MS));
      assert.strictEqual(bad.pending, 0);
    });

    it("exceptions from the sink are swallowed by dispose()", () => {
      const bad = new EventLogger(
        () => {
          throw new Error("server is down");
        },
        () => true,
        clock,
      );
      bad.log("a");
      assert.doesNotThrow(() => bad.dispose());
    });

    it("keeps working after a failure: later events reach the sink", () => {
      const received: RailEvent[][] = [];
      let fail = true;
      const flaky = new EventLogger(
        (events) => {
          if (fail) {
            throw new Error("down");
          }
          received.push(events);
        },
        () => true,
        clock,
      );
      flaky.log("lost");
      flaky.flush();
      fail = false;
      flaky.log("kept");
      clock.advance(FLUSH_MS);
      assert.deepStrictEqual(
        received.map((b) => b.map((e) => e.type)),
        [["kept"]],
      );
    });
  });
});
