import * as assert from "node:assert";
import { RestartPolicy } from "../../src/server/RestartPolicy";
import { FakeClock } from "./fakeClock";

const WINDOW_MS = 5 * 60_000;

describe("RestartPolicy", () => {
  let clock: FakeClock;
  let policy: RestartPolicy;

  beforeEach(() => {
    clock = new FakeClock(1_000_000);
    // Defaults for budget, window and base delay; only the clock is injected.
    policy = new RestartPolicy(undefined, undefined, undefined, () => clock.now());
  });

  it("backs off 1000, 2000, 4000 ms and then gives up", () => {
    assert.strictEqual(policy.nextDelay(), 1000);
    assert.strictEqual(policy.nextDelay(), 2000);
    assert.strictEqual(policy.nextDelay(), 4000);
    assert.strictEqual(policy.nextDelay(), null);
  });

  it("keeps returning null while the budget is spent", () => {
    for (let i = 0; i < 3; i++) {
      policy.nextDelay();
    }
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(policy.nextDelay(), null);
    }
    assert.strictEqual(policy.recentRestarts, 3, "refusals do not consume budget");
  });

  it("the backoff does not depend on how far apart the failures are (inside the window)", () => {
    assert.strictEqual(policy.nextDelay(), 1000);
    clock.advance(10_000);
    assert.strictEqual(policy.nextDelay(), 2000);
    clock.advance(100_000);
    assert.strictEqual(policy.nextDelay(), 4000);
    clock.advance(100_000);
    assert.strictEqual(policy.nextDelay(), null);
  });

  it("stays exhausted until the oldest restart leaves the 5-minute window", () => {
    assert.strictEqual(policy.nextDelay(), 1000); // t0
    clock.advance(1000);
    assert.strictEqual(policy.nextDelay(), 2000); // t0 + 1000
    clock.advance(1000);
    assert.strictEqual(policy.nextDelay(), 4000); // t0 + 2000
    clock.advance(WINDOW_MS - 2001); // t0 + 299_999
    assert.strictEqual(policy.nextDelay(), null, "the first restart is still 299 999 ms old");
    clock.advance(1); // t0 + 300_000: first restart is exactly one window old and expires
    assert.strictEqual(policy.nextDelay(), 4000, "two restarts remain in the window -> 1000 * 2^2");
    assert.strictEqual(policy.nextDelay(), null, "and the budget is spent again");
  });

  it("recovers one restart at a time as old restarts expire", () => {
    policy.nextDelay(); // t0
    clock.advance(1000);
    policy.nextDelay(); // t0 + 1000
    clock.advance(1000);
    policy.nextDelay(); // t0 + 2000
    clock.advance(WINDOW_MS - 2000); // t0 + 300_000: only the first has expired
    assert.strictEqual(policy.recentRestarts, 2);
    clock.advance(1000); // t0 + 301_000: the second has expired
    assert.strictEqual(policy.recentRestarts, 1);
    assert.strictEqual(policy.nextDelay(), 2000, "one restart still in the window -> 1000 * 2^1");
  });

  it("starts over at the base delay once the whole window has passed quietly", () => {
    policy.nextDelay();
    policy.nextDelay();
    policy.nextDelay();
    assert.strictEqual(policy.nextDelay(), null);
    clock.advance(WINDOW_MS + 1);
    assert.strictEqual(policy.recentRestarts, 0);
    assert.strictEqual(policy.nextDelay(), 1000);
    assert.strictEqual(policy.nextDelay(), 2000);
  });

  it("reset() restores the full budget and the base delay immediately", () => {
    policy.nextDelay();
    policy.nextDelay();
    policy.nextDelay();
    assert.strictEqual(policy.nextDelay(), null);
    policy.reset();
    assert.strictEqual(policy.recentRestarts, 0);
    assert.strictEqual(policy.nextDelay(), 1000);
    assert.strictEqual(policy.nextDelay(), 2000);
    assert.strictEqual(policy.nextDelay(), 4000);
    assert.strictEqual(policy.nextDelay(), null);
  });

  it("reset() on a fresh policy is harmless", () => {
    policy.reset();
    assert.strictEqual(policy.nextDelay(), 1000);
  });

  describe("recentRestarts", () => {
    it("counts restarts inside the window and nothing else", () => {
      assert.strictEqual(policy.recentRestarts, 0);
      policy.nextDelay();
      assert.strictEqual(policy.recentRestarts, 1);
      policy.nextDelay();
      assert.strictEqual(policy.recentRestarts, 2);
      clock.advance(WINDOW_MS - 1);
      assert.strictEqual(policy.recentRestarts, 2);
      clock.advance(1);
      assert.strictEqual(policy.recentRestarts, 0);
    });
  });

  describe("custom parameters", () => {
    it("respects maxRestarts, window and base delay", () => {
      const p = new RestartPolicy(2, 1000, 50, () => clock.now());
      assert.strictEqual(p.nextDelay(), 50);
      assert.strictEqual(p.nextDelay(), 100);
      assert.strictEqual(p.nextDelay(), null);
      clock.advance(1000);
      assert.strictEqual(p.nextDelay(), 50);
    });

    it("maxRestarts of 0 never restarts", () => {
      const p = new RestartPolicy(0, WINDOW_MS, 1000, () => clock.now());
      assert.strictEqual(p.nextDelay(), null);
    });

    it("a larger budget keeps doubling the delay", () => {
      const p = new RestartPolicy(5, WINDOW_MS, 1000, () => clock.now());
      const delays = Array.from({ length: 6 }, () => p.nextDelay());
      assert.deepStrictEqual(delays, [1000, 2000, 4000, 8000, 16000, null]);
    });
  });

  it("uses Date.now by default", () => {
    const real = new RestartPolicy();
    assert.strictEqual(real.nextDelay(), 1000);
    assert.strictEqual(real.recentRestarts, 1);
  });
});
