// Trailing-edge debouncer with an injectable timer, for deterministic tests.

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export class Debouncer {
  private handle: unknown;

  constructor(
    readonly delayMs: number,
    private readonly timers: Timers = realTimers,
  ) {}

  /** (Re)arm: ``fn`` runs ``delayMs`` after the last call. */
  trigger(fn: () => void): void {
    this.cancel();
    this.handle = this.timers.setTimeout(() => {
      this.handle = undefined;
      fn();
    }, this.delayMs);
  }

  cancel(): void {
    if (this.handle !== undefined) {
      this.timers.clearTimeout(this.handle);
      this.handle = undefined;
    }
  }

  get pending(): boolean {
    return this.handle !== undefined;
  }
}
