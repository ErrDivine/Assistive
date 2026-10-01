// Restart with exponential backoff, at most 3 restarts in 5 minutes (design plan §4).
// Pure logic with an injectable clock, so it is unit-testable.

export class RestartPolicy {
  private restarts: number[] = [];

  constructor(
    private readonly maxRestarts = 3,
    private readonly windowMs = 5 * 60_000,
    private readonly baseDelayMs = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Delay before the next restart, or null when the budget is spent. */
  nextDelay(): number | null {
    const t = this.now();
    this.restarts = this.restarts.filter((r) => t - r < this.windowMs);
    if (this.restarts.length >= this.maxRestarts) {
      return null;
    }
    const delay = this.baseDelayMs * 2 ** this.restarts.length;
    this.restarts.push(t);
    return delay;
  }

  reset(): void {
    this.restarts = [];
  }

  get recentRestarts(): number {
    const t = this.now();
    return this.restarts.filter((r) => t - r < this.windowMs).length;
  }
}
