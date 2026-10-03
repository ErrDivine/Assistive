// Manual clock for deterministic tests. Structurally satisfies `Timers`
// (context/debounce): nothing runs until `advance`.

interface Scheduled {
  id: number;
  due: number;
  fn: () => void;
}

const MAX_FIRINGS_PER_ADVANCE = 10_000;

export class FakeClock {
  private time: number;
  private nextId = 1;
  private timers: Scheduled[] = [];

  constructor(start = 0) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const handle: Scheduled = { id: this.nextId++, due: this.time + Math.max(0, ms), fn };
    this.timers.push(handle);
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t !== handle);
  }

  /** Number of timers that are armed and have not fired yet. */
  get pendingTimers(): number {
    return this.timers.length;
  }

  /**
   * Move time forward by ``ms``, firing every timer that becomes due, earliest
   * first (ties in arming order). While a callback runs, ``now()`` is that
   * timer's due time; timers armed by callbacks fire too if they fall inside
   * the window. Afterwards ``now()`` is exactly the start plus ``ms``.
   */
  advance(ms: number): void {
    const target = this.time + ms;
    // A regression that keeps re-arming a zero-delay timer must fail the test,
    // not hang the run.
    for (let fired = 0; ; fired++) {
      if (fired > MAX_FIRINGS_PER_ADVANCE) {
        throw new Error(`FakeClock.advance: more than ${MAX_FIRINGS_PER_ADVANCE} timers fired (runaway re-arming?)`);
      }
      let next: Scheduled | undefined;
      for (const t of this.timers) {
        if (t.due <= target && (!next || t.due < next.due || (t.due === next.due && t.id < next.id))) {
          next = t;
        }
      }
      if (!next) {
        break;
      }
      this.timers = this.timers.filter((t) => t !== next);
      this.time = Math.max(this.time, next.due);
      next.fn();
    }
    this.time = target;
  }
}
