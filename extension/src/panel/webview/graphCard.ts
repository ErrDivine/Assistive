import type { GraphNode } from "../../types";
import { ICON_PATHS, type IconName } from "./icons";

export const CARD_WIDTH = 216;
export const CARD_HEIGHT = 108;
export interface CardPalette {
  fg: string; muted: string; node: string; accent: string;
  planned: string; stubbed: string; done: string; attention: string;
}
const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const truncate = (s: string, length: number) => [...s].length > length ? [...s].slice(0, length - 1).join("") + "…" : s;
const glyph = (name: IconName, x: number, y: number, color: string) => `<g transform="translate(${x} ${y}) scale(.7)" fill="none" stroke="${xml(color)}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</g>`;

/** A theme-colored SVG card for Cytoscape. All model-supplied text is escaped. */
export function graphCard(n: GraphNode, order: number | undefined, next: boolean, p: CardPalette): string {
  const status = p[n.status];
  const text = (x: number, y: number, value: string, color: string, size = 11, weight = 400) =>
    `<text x="${x}" y="${y}" fill="${xml(color)}" font-family="Arial, sans-serif" font-size="${size}" font-weight="${weight}">${xml(value)}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
    <rect x="1" y="1" width="214" height="106" rx="8" fill="${xml(p.node)}" stroke="${xml(next ? p.accent : p.muted)}" stroke-opacity="${next ? 1 : .45}" stroke-width="${next ? 2 : 1}"/>
    ${glyph(n.kind, 12, 11, p.muted)}${text(32, 22, n.kind === "concept" ? "responsibility" : n.kind, p.muted)}
    ${order === undefined ? "" : text(198, 22, String(order), p.muted)}
    ${text(12, 45, truncate(n.label, 27), p.fg, 13, 600)}
    ${text(12, 64, truncate(n.signature ?? n.symbol ?? n.description, 33), p.muted, 10)}
    <path d="M12 76h192" stroke="${xml(p.muted)}" stroke-opacity=".2"/>
    ${glyph(n.status, 12, 85, status)}${text(32, 96, n.status, status)}
    ${next ? text(144, 96, "NEXT STEP", p.accent, 9, 600) : ""}
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
