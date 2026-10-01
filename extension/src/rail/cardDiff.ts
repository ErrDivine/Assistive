// Card diffing and the live-section stability rules (design plan §9.7).
// No `vscode` or DOM imports: shared by the extension host, webview and tests.

import type { Card } from "../types";

/** Identity plus content: an unchanged key means the DOM node can stay as is. */
export function cardKey(card: Card): string {
  const facts = card.facts.map((f) => `${f.label}\u0001${f.text}`).join("\u0002");
  return [
    card.id,
    card.title,
    facts,
    card.snippet?.text ?? "",
    card.stale ? "s" : "",
    card.pinned ? "p" : "",
  ].join("\u0003");
}

export function sameCards(a: Card[], b: Card[]): boolean {
  return a.length === b.length && a.every((c, i) => cardKey(c) === cardKey(b[i]));
}

export interface CardDiff {
  /** Card ids whose DOM node is kept untouched. */
  keep: string[];
  /** Cards to (re)create. */
  create: Card[];
  /** Card ids whose DOM node goes away. */
  remove: string[];
  /** Final order of ids. */
  order: string[];
}

export function diffCards(previous: Card[], next: Card[]): CardDiff {
  const prev = new Map(previous.map((c) => [c.id, cardKey(c)]));
  const keep: string[] = [];
  const create: Card[] = [];
  for (const card of next) {
    if (prev.get(card.id) === cardKey(card)) {
      keep.push(card.id);
    } else {
      create.push(card);
    }
  }
  const nextIds = new Set(next.map((c) => c.id));
  const changed = new Set(create.map((c) => c.id));
  const remove = previous
    .filter((c) => !nextIds.has(c.id) || changed.has(c.id))
    .map((c) => c.id);
  return { keep, create, remove, order: next.map((c) => c.id) };
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const MIN_VISIBLE_MS = 1500;
export const EMPTY_FADE_MS = 3000;

/**
 * Decides when the live section re-renders:
 * - unchanged cards cause no render;
 * - a shown card stays at least 1.5 s before it can be replaced;
 * - an empty result fades the section out after 3 s instead of clearing it.
 */
export class LiveScheduler {
  private shown: { card: Card; since: number }[] = [];
  private pending?: Card[];
  private pendingTimer?: unknown;
  private fadeTimer?: unknown;
  renders = 0;

  constructor(
    private readonly render: (cards: Card[], fade: boolean) => void,
    private readonly clock: Clock = realClock,
    private readonly minVisibleMs = MIN_VISIBLE_MS,
    private readonly fadeMs = EMPTY_FADE_MS,
  ) {}

  get current(): Card[] {
    return this.shown.map((s) => s.card);
  }

  update(cards: Card[]): void {
    if (cards.length === 0) {
      this.clearPending();
      if (this.shown.length > 0 && this.fadeTimer === undefined) {
        this.fadeTimer = this.clock.setTimeout(() => {
          this.fadeTimer = undefined;
          this.apply([], true);
        }, this.fadeMs);
      }
      return;
    }
    this.cancelFade();
    if (sameCards(this.current, cards)) {
      this.clearPending();
      return;
    }
    const readyAt = this.readyAt(cards);
    const now = this.clock.now();
    if (readyAt <= now) {
      this.clearPending();
      this.apply(cards, false);
      return;
    }
    this.pending = cards;
    if (this.pendingTimer !== undefined) {
      this.clock.clearTimeout(this.pendingTimer);
    }
    this.pendingTimer = this.clock.setTimeout(() => {
      this.pendingTimer = undefined;
      const next = this.pending;
      this.pending = undefined;
      if (next) {
        this.update(next);
      }
    }, readyAt - now);
  }

  /** Remove one card right away (user dismissed it). */
  remove(cardId: string): void {
    const next = this.current.filter((c) => c.id !== cardId);
    if (next.length !== this.shown.length) {
      this.apply(next, false);
    }
  }

  /** Re-render the current cards with updated content (e.g. pin state). */
  refresh(map: (c: Card) => Card): void {
    const next = this.current.map(map);
    if (!sameCards(this.current, next)) {
      this.apply(next, false);
    }
  }

  dispose(): void {
    this.clearPending();
    this.cancelFade();
  }

  private readyAt(next: Card[]): number {
    const keep = new Set(next.map((c) => c.id));
    let t = 0;
    for (const s of this.shown) {
      if (!keep.has(s.card.id)) {
        t = Math.max(t, s.since + this.minVisibleMs);
      }
    }
    return t;
  }

  private apply(cards: Card[], fade: boolean): void {
    const now = this.clock.now();
    const since = new Map(this.shown.map((s) => [s.card.id, s.since]));
    this.shown = cards.map((card) => ({ card, since: since.get(card.id) ?? now }));
    this.renders += 1;
    this.render(cards, fade);
  }

  private clearPending(): void {
    if (this.pendingTimer !== undefined) {
      this.clock.clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    this.pending = undefined;
  }

  private cancelFade(): void {
    if (this.fadeTimer !== undefined) {
      this.clock.clearTimeout(this.fadeTimer);
      this.fadeTimer = undefined;
    }
  }
}
