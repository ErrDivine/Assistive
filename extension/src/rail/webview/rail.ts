// Rail webview script. Vanilla TypeScript, no framework (design plan §6).
// Cards are diffed by id: unchanged cards keep their DOM nodes untouched.

import type { Card, Fact } from "../../types";
import { cardKey, diffCards } from "../cardDiff";

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

type Section = "live" | "pinned" | "frequent";

const state: Record<Section, Card[]> = { live: [], pinned: [], frequent: [] };
const renders: Record<Section, number> = { live: 0, pinned: 0, frequent: 0 };
const nodes = new Map<string, HTMLElement>(); // `${section}:${id}` -> node

const LABELS: Record<Fact["label"], string> = {
  signature: "",
  summary: "",
  returns: "Returns",
  raises: "Raises",
  param: "Param",
  note: "Note",
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function sourceLabel(card: Card): string {
  const s = card.source;
  if (s.runtime) return `runtime docs · Python ${s.runtime.pythonVersion}`;
  const file = s.path.split(/[\\/]/).slice(-2).join("/");
  return `${file}:${s.startLine}`;
}

function renderFact(f: Fact): HTMLElement {
  const li = el("li", `fact fact-${f.label}`);
  li.title = `${f.span.path}:${f.span.startLine}-${f.span.endLine}`;
  const label = LABELS[f.label];
  if (label) li.append(el("span", "label", label));
  if (f.label === "signature") {
    li.append(el("code", "sig", f.text));
  } else {
    li.append(el("span", "text", f.text));
  }
  if (f.origin === "source_scan") li.append(el("span", "origin", "found in source"));
  return li;
}

function renderCard(card: Card, section: Section): HTMLElement {
  const art = el("article", `card kind-${card.kind}`);
  art.dataset.id = card.id;
  art.dataset.key = cardKey(card);
  const head = el("header");
  head.append(el("span", "title", card.title));
  const badges = el("span", "badges");
  if (card.source.deleted && card.source.commit) {
    badges.append(el("span", "badge deleted", `deleted in ${card.source.commit.slice(0, 7)}`));
  }
  if (card.stale) badges.append(el("span", "badge stale", "re-indexing"));
  if (card.pinned && section !== "pinned") badges.append(el("span", "badge", "pinned"));
  head.append(badges);
  art.append(head);
  const meta = el("div", "meta");
  meta.append(el("span", "reason", card.reason));
  meta.append(el("span", "where", sourceLabel(card)));
  if (card.authoredAt && card.kind === "precedent") {
    meta.append(el("span", "when", card.authoredAt.slice(0, 10)));
  }
  art.append(meta);
  const facts = el("ul", "facts");
  for (const f of card.facts) facts.append(renderFact(f));
  art.append(facts);
  if (card.snippet) {
    const pre = el("pre", "snippet");
    pre.append(el("code", undefined, card.snippet.text));
    art.append(pre);
  }
  const actions = el("div", "actions");
  const add = (act: string, label: string, title: string) => {
    const b = el("button", undefined, label);
    b.dataset.act = act;
    b.title = title;
    actions.append(b);
  };
  add("open", "Open", "Open source (peek, keeps focus in the editor)");
  if (section === "pinned" || card.pinned) add("unpin", "Unpin", "Unpin this card");
  else add("pin", "Pin", "Keep this card in the Pinned section");
  add("copy", "Copy", "Copy to clipboard (never inserted into your code)");
  if (section === "live") add("dismiss", "Dismiss", "Hide this card");
  art.append(actions);
  return art;
}

function container(section: Section): HTMLElement {
  return document.querySelector(`#${section} .cards`) as HTMLElement;
}

function renderSection(section: Section, cards: Card[], fade = false): void {
  const box = container(section);
  const root = document.getElementById(section)!;
  if (section === "live") {
    if (fade && cards.length === 0) {
      root.classList.add("fading");
      window.setTimeout(() => {
        if (state.live.length === 0) {
          applyDiff(section, box, []);
          root.classList.remove("fading");
          updateEmpty();
        }
      }, 320);
      state.live = [];
      renders.live += 1;
      ack(section);
      return;
    }
    root.classList.remove("fading");
  }
  applyDiff(section, box, cards);
  state[section] = cards;
  renders[section] += 1;
  if (section !== "live") {
    root.hidden = cards.length === 0;
    const count = root.querySelector(".count");
    if (count) count.textContent = String(cards.length);
  }
  updateEmpty();
  ack(section);
}

function applyDiff(section: Section, box: HTMLElement, cards: Card[]): void {
  const diff = diffCards(state[section], cards);
  for (const id of diff.remove) {
    nodes.get(`${section}:${id}`)?.remove();
    nodes.delete(`${section}:${id}`);
  }
  for (const card of diff.create) {
    nodes.set(`${section}:${card.id}`, renderCard(card, section));
  }
  // Re-order without touching nodes that are already in place.
  let prev: Element | null = null;
  for (const id of diff.order) {
    const node = nodes.get(`${section}:${id}`)!;
    const expectedNext: Element | null = prev ? prev.nextElementSibling : box.firstElementChild;
    if (expectedNext !== node) {
      box.insertBefore(node, expectedNext);
    }
    prev = node;
  }
}

function updateEmpty(): void {
  const empty = document.getElementById("empty")!;
  empty.hidden = state.live.length > 0;
}

function ack(section: Section): void {
  vscode.postMessage({ type: "rendered", section, renders: { ...renders } });
}

document.addEventListener("click", (ev) => {
  const btn = (ev.target as HTMLElement).closest("button[data-act]") as HTMLButtonElement | null;
  if (!btn) return;
  const card = btn.closest("article.card") as HTMLElement | null;
  const section = btn.closest("section, details")?.id as Section | undefined;
  if (!card || !section) return;
  vscode.postMessage({ type: btn.dataset.act, cardId: card.dataset.id, section });
});

window.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as { type: string; [k: string]: unknown };
  switch (msg.type) {
    case "live":
    case "pinned":
    case "frequent":
      renderSection(msg.type, msg.cards as Card[], Boolean(msg.fade));
      break;
    case "status":
      document.getElementById("status")!.textContent = String(msg.text ?? "");
      break;
    case "paused": {
      const paused = Boolean(msg.paused);
      document.body.classList.toggle("paused", paused);
      document.getElementById("empty")!.textContent = paused
        ? "Rail paused. Run “Reference Rail: Pause / Resume” to resume."
        : "Move the cursor onto a Python symbol, or press Ctrl+Alt+/ to ask.";
      break;
    }
  }
});

vscode.postMessage({ type: "ready" });
