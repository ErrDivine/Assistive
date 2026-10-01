// The rail: a WebviewView with Frequent, Pinned and Live sections (design plan §9.7).

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as vscode from "vscode";
import type { Card } from "../types";
import { LiveScheduler } from "./cardDiff";

export type CardAction = "open" | "pin" | "unpin" | "copy" | "dismiss";
type Section = "live" | "pinned" | "frequent";

export interface RailHandlers {
  onAction(action: CardAction, card: Card, section: Section): void;
  onShown(cards: Card[]): void;
  onReady(): void;
}

const DISMISS_MS = 10 * 60_000;

export class RailViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "referenceRail.rail";

  private view?: vscode.WebviewView;
  private readonly live: LiveScheduler;
  private pinned: Card[] = [];
  private frequent: Card[] = [];
  private statusText = "Starting…";
  private paused = false;
  private readonly dismissed = new Map<string, number>();
  private lastLive: { cards: Card[]; fade: boolean } = { cards: [], fade: false };
  /** Renders acknowledged by the webview, per section (used by tests). */
  readonly webviewRenders: Record<Section, number> = { live: 0, pinned: 0, frequent: 0 };
  /** Live renders decided by the extension (posted to the webview). */
  liveRenders = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: RailHandlers,
  ) {
    this.live = new LiveScheduler((cards, fade) => {
      this.liveRenders += 1;
      this.lastLive = { cards, fade };
      const before = new Set(this.lastShownIds);
      this.lastShownIds = cards.map((c) => c.id);
      const fresh = cards.filter((c) => !before.has(c.id));
      if (fresh.length) {
        this.handlers.onShown(fresh);
      }
      void this.post({ type: "live", cards, fade });
    });
  }

  private lastShownIds: string[] = [];

  get liveCards(): Card[] {
    return this.live.current;
  }

  get pinnedCards(): Card[] {
    return this.pinned;
  }

  get frequentCards(): Card[] {
    return this.frequent;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const distUri = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [distUri] };
    view.webview.html = this.html(view.webview, distUri);
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  private html(webview: vscode.Webview, distUri: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const template = fs.readFileSync(vscode.Uri.joinPath(distUri, "index.html").fsPath, "utf8");
    return template
      .replace(/{{cspSource}}/g, webview.cspSource)
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{scriptUri}}/g, webview.asWebviewUri(vscode.Uri.joinPath(distUri, "rail.js")).toString())
      .replace(/{{styleUri}}/g, webview.asWebviewUri(vscode.Uri.joinPath(distUri, "rail.css")).toString());
  }

  private onMessage(msg: { type: string; cardId?: string; section?: Section; renders?: Record<Section, number> }): void {
    if (msg.type === "ready") {
      this.replay();
      this.handlers.onReady();
      return;
    }
    if (msg.type === "rendered" && msg.renders) {
      Object.assign(this.webviewRenders, msg.renders);
      return;
    }
    const card = msg.cardId ? this.find(msg.cardId, msg.section) : undefined;
    if (!card || !msg.section) {
      return;
    }
    const action = msg.type as CardAction;
    if (action === "dismiss") {
      this.dismiss(card.id);
    }
    this.handlers.onAction(action, card, msg.section);
  }

  /** Send everything again (the webview was (re)created). */
  private replay(): void {
    void this.post({ type: "paused", paused: this.paused });
    void this.post({ type: "status", text: this.statusText });
    void this.post({ type: "frequent", cards: this.frequent });
    void this.post({ type: "pinned", cards: this.pinned });
    void this.post({ type: "live", cards: this.lastLive.cards, fade: false });
  }

  find(cardId: string, section?: Section): Card | undefined {
    const pools: Card[][] =
      section === "pinned" ? [this.pinned] : section === "frequent" ? [this.frequent] : [this.live.current, this.pinned, this.frequent];
    for (const pool of pools) {
      const hit = pool.find((c) => c.id === cardId);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }

  showLive(cards: Card[]): void {
    const now = Date.now();
    for (const [id, until] of this.dismissed) {
      if (until < now) {
        this.dismissed.delete(id);
      }
    }
    this.live.update(cards.filter((c) => !this.dismissed.has(c.id)));
  }

  dismiss(cardId: string): void {
    this.dismissed.set(cardId, Date.now() + DISMISS_MS);
    this.live.remove(cardId);
  }

  setPinned(cards: Card[]): void {
    this.pinned = cards;
    const ids = new Set(cards.map((c) => c.qualname));
    this.live.refresh((c) => ({ ...c, pinned: c.qualname ? ids.has(c.qualname) : c.pinned }));
    void this.post({ type: "pinned", cards });
  }

  setFrequent(cards: Card[]): void {
    this.frequent = cards;
    void this.post({ type: "frequent", cards });
  }

  setStatus(text: string): void {
    this.statusText = text;
    void this.post({ type: "status", text });
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    void this.post({ type: "paused", paused });
    if (paused) {
      this.live.update([]);
    }
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  private post(msg: unknown): Thenable<boolean> | undefined {
    return this.view?.webview.postMessage(msg);
  }

  dispose(): void {
    this.live.dispose();
  }
}
