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

/** Fixed ring buffer of the most recent items. */
export class Ring<T> {
  private items: T[] = [];

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  toArray(): T[] {
    return [...this.items];
  }

  clear(): void {
    this.items = [];
  }
}

/**
 * Pick whole lines around ``cursorIdx`` whose UTF-8 size (with newlines) stays
 * within ``maxBytes``. Returns inclusive indexes into ``lines``.
 */
export function fitLines(lines: string[], cursorIdx: number, maxBytes = 4096): [number, number] {
  if (lines.length === 0) {
    return [0, -1];
  }
  const size = (i: number) => Buffer.byteLength(lines[i], "utf8") + 1;
  let lo = Math.max(0, Math.min(cursorIdx, lines.length - 1));
  let hi = lo;
  let total = size(lo);
  if (total > maxBytes) {
    return [lo, hi];
  }
  // Grow alternately upward (the def header matters most) and downward.
  let grew = true;
  while (grew) {
    grew = false;
    if (lo > 0 && total + size(lo - 1) <= maxBytes) {
      lo -= 1;
      total += size(lo);
      grew = true;
    }
    if (hi < lines.length - 1 && total + size(hi + 1) <= maxBytes) {
      hi += 1;
      total += size(hi);
      grew = true;
    }
  }
  return [lo, hi];
}
