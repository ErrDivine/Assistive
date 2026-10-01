// Event logger (design plan §9.8). Events are batched every 2 s and sent to the
// local server; nothing ever leaves the machine (invariant I7).

import type { RailEvent } from "../types";
import { Clock, realClock } from "../rail/cardDiff";

export const FLUSH_MS = 2000;

export class EventLogger {
  private queue: RailEvent[] = [];
  private timer?: unknown;
  private lastTickMinute = -1;
  private disposed = false;

  constructor(
    private readonly sink: (events: RailEvent[]) => void,
    private readonly railEnabled: () => boolean,
    private readonly clock: Clock = realClock,
    private readonly flushMs = FLUSH_MS,
  ) {}

  log(type: string, fields: Omit<RailEvent, "ts" | "type"> = {}): void {
    if (this.disposed) {
      return;
    }
    this.queue.push({ ts: new Date(this.clock.now()).toISOString(), type, ...fields });
    if (this.timer === undefined) {
      this.timer = this.clock.setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, this.flushMs);
    }
  }

  /** One ``edit_tick`` per wall-clock minute that has any edits. */
  noteEdit(): void {
    const minute = Math.floor(this.clock.now() / 60_000);
    if (minute !== this.lastTickMinute) {
      this.lastTickMinute = minute;
      this.log("edit_tick", { payload: { railEnabled: this.railEnabled() } });
    }
  }

  flush(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.queue.length === 0) {
      return;
    }
    const batch = this.queue;
    this.queue = [];
    try {
      this.sink(batch);
    } catch {
      // The server is down: events are dropped rather than blocking the editor.
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  dispose(): void {
    this.flush();
    this.disposed = true;
  }
}
