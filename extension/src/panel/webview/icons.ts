// Local SVG artwork; no icon fonts, emoji or remote assets.
export const ICON_PATHS = {
  concept: '<path d="m10 2 8 8-8 8-8-8 8-8Zm-4 8h8m-4-4v8"/>',
  graph: '<rect x="2" y="2" width="6" height="5" rx="1"/><rect x="12" y="13" width="6" height="5" rx="1"/><rect x="2" y="13" width="6" height="5" rx="1"/><path d="M5 7v3h10v3M5 10v3"/>',
  module: '<rect x="2" y="3" width="16" height="14" rx="2"/><path d="M2 7h16M7 7v10"/>',
  class: '<path d="m10 2 8 4v8l-8 4-8-4V6l8-4ZM2 6l8 4 8-4M10 10v8"/>',
  function: '<path d="M13 3h-2c-2 0-3 2-3 4l-1 7c0 2-1 3-3 3H3M5 8h9m0 4 4 5m0-5-4 5"/>',
  method: '<path d="m6 5-4 5 4 5m8-10 4 5-4 5M12 3l-4 14"/>',
  data: '<ellipse cx="10" cy="4" rx="7" ry="2"/><path d="M3 4v12c0 3 14 3 14 0V4M3 10c0 3 14 3 14 0"/>',
  constant: '<path d="M4 4h12v12H4zM7 10h6"/>',
  test: '<path d="M7 2h6m-5 0v6l-5 8c-1 2 15 2 14 0l-5-8V2M6 12h8"/>',
  external: '<path d="M11 3h6v6m0-6-9 9M8 3H3v14h14v-5"/>',
  step: '<path d="M8 5h10M8 10h10M8 15h10M2 5h1m-1 5h1m-1 5h1"/>',
  planned: '<circle cx="10" cy="10" r="7" stroke-dasharray="2 3"/>',
  stubbed: '<circle cx="10" cy="10" r="7"/><path d="M10 5v5l3 2"/>',
  done: '<circle cx="10" cy="10" r="7"/><path d="m6 10 3 3 5-6"/>',
  attention: '<path d="m10 2 8 15H2L10 2Zm0 5v4m0 3v.5"/>',
  settings: '<path d="M4 4h12v12H4zM7 2v4m6-4v4M7 14v4m6-4v4M2 7h4m-4 6h4m8-6h4m-4 6h4"/><circle cx="10" cy="10" r="2"/>',
  heartbeat: '<path d="M2 10h4l2-6 4 12 2-6h4"/>',
  fit: '<path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  minus: '<path d="M4 10h12"/>',
  arrow: '<path d="M3 10h14m-5-5 5 5-5 5"/>',
  undo: '<path d="M7 3 3 7l4 4M3 7h8a6 6 0 0 1 0 12"/>',
  sync: '<path d="M17 7A7 7 0 0 0 4 5L2 7m0-5v5h5M3 13a7 7 0 0 0 13 2l2-2m0 5v-5h-5"/>',
  book: '<path d="M10 5C7 2 3 3 2 3v13c3-1 6-1 8 1 2-2 5-2 8-1V3c-1 0-5-1-8 2v12"/>',
  lightbulb: '<path d="M7 14c0-2-3-3-3-7a6 6 0 0 1 12 0c0 4-3 5-3 7H7Zm0 3h6m-5 2h4"/>',
  lock: '<rect x="4" y="9" width="12" height="9" rx="2"/><path d="M6 9V6a4 4 0 0 1 8 0v3M10 13v2"/>',
  edit: '<path d="m3 13 10-10 4 4L7 17H3v-4ZM11 5l4 4"/>',
  stop: '<rect x="4" y="4" width="12" height="12" rx="1"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function icon(name: IconName): string {
  return `<svg class="svg-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;
}
