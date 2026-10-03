// The panel webview: the implementation graph (cytoscape + dagre layout), the
// typing-order steps, node details, the activity feed and the input box.
// All state comes from the extension host; actions go back as messages.

import cytoscape from "cytoscape";
import dagre from "cytoscape-dagre";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { orderedNodes, progress } from "../../graph/order";
import type { FeedItem, FileGraph, FromPanel, GraphNode, PanelState, Resource, ToPanel } from "../../types";

declare function acquireVsCodeApi(): {
  postMessage(msg: FromPanel): void;
  getState(): { tab?: "graph" | "steps"; selected?: string } | undefined;
  setState(s: { tab?: "graph" | "steps"; selected?: string }): void;
};

cytoscape.use(dagre);
const vscode = acquireVsCodeApi();
const post = (m: FromPanel) => vscode.postMessage(m);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let state: PanelState | undefined;
const saved = vscode.getState() ?? {};
let tab: "graph" | "steps" = saved.tab ?? "graph";
let selected: string | undefined = saved.selected;
let structureKey = "";
let lastFile: string | undefined;

function persist(): void {
  vscode.setState({ tab, selected });
}

// ---------------------------------------------------------------- utilities

function esc(s: string | undefined): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function md(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}

function time(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function el(tag: string, cls?: string, html?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function button(label: string, cls: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = cls;
  if (title) b.title = title;
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return b;
}

// ---------------------------------------------------------------- theme colors

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function palette() {
  return {
    fg: cssVar("--vscode-foreground", "#ccc"),
    muted: cssVar("--vscode-descriptionForeground", "#999"),
    bg: cssVar("--vscode-sideBar-background", "#1e1e1e"),
    node: cssVar("--vscode-editor-background", "#1e1e1e"),
    edge: cssVar("--vscode-editorLineNumber-foreground", "#888"),
    accent: cssVar("--vscode-focusBorder", "#007fd4"),
    planned: cssVar("--vscode-descriptionForeground", "#888"),
    stubbed: cssVar("--vscode-charts-yellow", "#d7ba7d"),
    done: cssVar("--vscode-charts-green", "#89d185"),
    attention: cssVar("--vscode-charts-red", "#f14c4c"),
    font: cssVar("--vscode-font-family", "sans-serif"),
  };
}

function graphStyle(): cytoscape.StylesheetJson {
  const p = palette();
  return [
    {
      selector: "node",
      style: {
        shape: "round-rectangle",
        "background-color": p.node,
        "background-opacity": 1,
        "border-width": 1.5,
        "border-color": p.planned,
        label: "data(text)",
        color: p.fg,
        "font-size": 11,
        "font-family": p.font,
        "text-valign": "center",
        "text-halign": "center",
        "text-wrap": "wrap",
        "text-max-width": "150px",
        width: "data(w)",
        height: "data(h)",
      },
    },
    { selector: "node.planned", style: { "border-style": "dashed" } },
    { selector: "node.stubbed", style: { "border-color": p.stubbed, "background-color": p.stubbed, "background-opacity": 0.16 } },
    { selector: "node.done", style: { "border-color": p.done, "background-color": p.done, "background-opacity": 0.18, "border-width": 2 } },
    {
      selector: "node.attention",
      style: { "border-color": p.attention, "background-color": p.attention, "background-opacity": 0.2, "border-width": 3 },
    },
    { selector: "node.kind-external", style: { shape: "cut-rectangle", "border-style": "dotted", color: p.muted } },
    { selector: "node.kind-data", style: { shape: "barrel" } },
    { selector: "node.kind-step", style: { shape: "ellipse" } },
    { selector: "node.kind-test", style: { shape: "hexagon" } },
    { selector: "node.kind-constant", style: { shape: "round-tag" } },
    { selector: "node.kind-class, node.kind-module", style: { "font-weight": "bold" } },
    { selector: "node:selected", style: { "overlay-color": p.accent, "overlay-opacity": 0.18, "overlay-padding": 4 } },
    {
      selector: "node.next",
      style: { "underlay-color": p.accent, "underlay-opacity": 0.35, "underlay-padding": 5, "underlay-shape": "round-rectangle" },
    },
    {
      selector: "edge",
      style: {
        width: 1.2,
        "line-color": p.edge,
        "target-arrow-color": p.edge,
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.8,
        "curve-style": "bezier",
        label: "data(text)",
        "font-size": 9,
        "font-family": p.font,
        color: p.muted,
        "text-rotation": "autorotate",
        "text-background-color": p.bg,
        "text-background-opacity": 1,
        "text-background-padding": "1px",
      },
    },
    { selector: "edge.kind-contains", style: { "line-style": "dashed", "target-arrow-shape": "none" } },
    { selector: "edge.kind-depends", style: { "line-style": "dotted" } },
    { selector: "edge.dim, node.dim", style: { opacity: 0.25 } },
  ];
}

// ---------------------------------------------------------------- graph view

const measure = document.createElement("canvas").getContext("2d")!;

function nodeText(n: GraphNode, order: Map<string, number>): string {
  const i = order.get(n.id);
  return `${i !== undefined ? `${i}. ` : ""}${n.label}`;
}

function nodeSize(text: string): { w: number; h: number } {
  measure.font = `11px ${palette().font}`;
  const words = text.split(/\s+/);
  const maxW = 150;
  let lines = 1;
  let line = 0;
  let widest = 0;
  for (const w of words) {
    const ww = measure.measureText(w + " ").width;
    if (line + ww > maxW && line > 0) {
      lines++;
      widest = Math.max(widest, line);
      line = ww;
    } else {
      line += ww;
    }
  }
  widest = Math.max(widest, line);
  return { w: Math.max(56, Math.min(maxW, widest) + 22), h: 14 * lines + 14 };
}

const cy = cytoscape({
  container: $("cy"),
  style: graphStyle(),
  minZoom: 0.3,
  maxZoom: 2.5,
  wheelSensitivity: 0.25,
  boxSelectionEnabled: false,
  autoungrabify: false,
});

cy.on("tap", "node", (ev) => select(ev.target.id()));
cy.on("tap", (ev) => {
  if (ev.target === cy) select(undefined);
});
cy.on("dbltap", "node", (ev) => {
  const n = state?.graph?.nodes.find((x) => x.id === ev.target.id());
  if (n?.line !== undefined) post({ type: "goto", line: n.line });
});

function stepNumbers(graph: FileGraph): Map<string, number> {
  return new Map(orderedNodes(graph).map((n, i) => [n.id, i + 1]));
}

function renderGraph(graph: FileGraph | undefined): void {
  if (!graph || !graph.nodes.length) {
    cy.elements().remove();
    structureKey = "";
    return;
  }
  const order = stepNumbers(graph);
  const next = progress(graph).next?.id;
  const key =
    graph.file +
    "|" +
    graph.nodes.map((n) => n.id).sort().join(",") +
    "|" +
    graph.edges.map((e) => `${e.from}>${e.to}:${e.kind}`).sort().join(",");
  const nodeData = (n: GraphNode) => {
    const text = nodeText(n, order);
    return { id: n.id, text, ...nodeSize(text) };
  };
  const classesOf = (n: GraphNode) => `${n.status} kind-${n.kind}${n.id === next ? " next" : ""}`;
  if (key === structureKey) {
    for (const n of graph.nodes) {
      const ele = cy.getElementById(n.id);
      ele.data(nodeData(n));
      ele.classes(classesOf(n));
    }
    for (const e of graph.edges) {
      cy.getElementById(`${e.from}>${e.to}:${e.kind}`).data("text", e.label ? `${e.kind}: ${e.label}` : e.kind);
    }
    return;
  }
  structureKey = key;
  cy.elements().remove();
  cy.add([
    ...graph.nodes.map((n) => ({ group: "nodes" as const, data: nodeData(n), classes: classesOf(n) })),
    ...graph.edges.map((e) => ({
      group: "edges" as const,
      data: { id: `${e.from}>${e.to}:${e.kind}`, source: e.from, target: e.to, text: e.label ? `${e.kind}: ${e.label}` : e.kind },
      classes: `kind-${e.kind}`,
    })),
  ]);
  layout();
  if (selected && cy.getElementById(selected).nonempty()) {
    cy.getElementById(selected).select();
  }
}

/** The programmer zoomed or panned since the last layout: resizes then keep their view. */
let userViewport = false;

/** Fit the whole graph into the view (at most 1.3× zoom). */
function fit(): void {
  cy.fit(undefined, 12);
  if (cy.zoom() > 1.3) {
    cy.zoom(1.3);
    cy.center();
  }
}

function layout(): void {
  if (tab !== "graph" || !cy.nodes().length) {
    return;
  }
  userViewport = false;
  cy.resize();
  cy.layout({
    name: "dagre",
    rankDir: "TB",
    nodeSep: 24,
    rankSep: 46,
    edgeSep: 8,
    padding: 12,
    fit: false,
    animate: false,
  } as cytoscape.LayoutOptions).run();
  fit();
}

function renderSteps(graph: FileGraph | undefined): void {
  const list = $("steps");
  list.innerHTML = "";
  if (!graph) return;
  const next = progress(graph).next?.id;
  for (const n of orderedNodes(graph)) {
    const li = el(
      "li",
      [n.id === selected ? "selected" : "", n.id === next ? "next" : ""].filter(Boolean).join(" "),
      `<span class="label">${esc(n.label)}</span><span class="status ${n.status}">${n.status === "done" ? "✓ done" : n.status}</span>` +
        (n.id === next ? `<span class="badge" title="The next piece to type, in typing order">next</span>` : "") +
        (n.signature ? `<span class="sig">${esc(n.signature)}</span>` : ""),
    );
    li.addEventListener("click", () => select(n.id));
    li.addEventListener("dblclick", () => n.line !== undefined && post({ type: "goto", line: n.line }));
    // Keyboard: arrows move, Enter selects, Ctrl/Cmd+Enter goes to the code.
    li.tabIndex = 0;
    li.setAttribute("aria-label", `Step ${list.children.length + 1}: ${n.label}, ${n.status}${n.id === next ? ", next" : ""}`);
    li.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        ((ev.key === "ArrowDown" ? li.nextElementSibling : li.previousElementSibling) as HTMLElement | null)?.focus();
      } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        if (n.line !== undefined) post({ type: "goto", line: n.line });
      } else if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        select(n.id);
        (list.querySelector(`li[data-id="${CSS.escape(n.id)}"]`) as HTMLElement | null)?.focus();
      }
    });
    li.dataset.id = n.id;
    list.appendChild(li);
  }
}

function select(id: string | undefined): void {
  selected = id;
  persist();
  cy.nodes().unselect();
  cy.elements().removeClass("dim");
  if (id) {
    const ele = cy.getElementById(id);
    if (ele.nonempty()) {
      ele.select();
      const hood = ele.closedNeighborhood();
      cy.elements().not(hood).addClass("dim");
    }
  }
  renderDetails();
  if (tab === "steps") renderSteps(state?.graph);
}

function renderDetails(): void {
  const box = $("details");
  const graph = state?.graph;
  const n = graph?.nodes.find((x) => x.id === selected);
  if (!graph || !n) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const out = graph.edges.filter((e) => e.from === n.id).map((e) => `${e.kind} <b>${esc(e.to)}</b>`);
  const inc = graph.edges.filter((e) => e.to === n.id).map((e) => `<b>${esc(e.from)}</b> ${e.kind} it`);
  box.hidden = false;
  box.innerHTML =
    `<h3>${esc(n.label)} <span class="chip">${n.kind}</span><span class="chip status-${n.status}">${n.status}</span>` +
    `${n.line !== undefined ? `<span class="chip">L${n.line + 1}</span>` : ""}</h3>` +
    (n.signature ? `<code class="signature">${esc(n.signature)}</code>` : "") +
    `<p>${esc(n.description)}</p>` +
    (n.notes.length ? `<ul>${n.notes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "") +
    (n.attention ? `<p class="attention">⚠ ${esc(n.attention)}</p>` : "") +
    (out.length || inc.length ? `<p class="muted">${[...out, ...inc].join(" · ")}</p>` : "");
  const actions = el("div", "actions");
  const go = button(n.line !== undefined ? "Go to code" : "Not typed yet", "secondary", () => n.line !== undefined && post({ type: "goto", line: n.line }));
  go.disabled = n.line === undefined;
  const name = n.symbol ?? n.id;
  const typed = n.line !== undefined && (n.status === "done" || n.status === "attention");
  actions.append(
    go,
    // A learner's two questions: how do I start this, and is what I wrote right?
    typed
      ? button("Review", "secondary", () => post({ type: "send", text: reviewRequest(name) }), "Ask for a review of your code for this piece")
      : button("Hint", "secondary", () => post({ type: "send", text: hintRequest(name) }), "Ask how to start, without the code"),
    button("Copy signature", "secondary", () => post({ type: "copy", text: n.signature ?? n.symbol ?? n.label }), "Copy to the clipboard"),
    button("Ask about this", "secondary", () => focusInput(`About \`${name}\`: `)),
  );
  // Edits that need no LLM. Code nodes get their status from the code; steps and externals from you.
  if (n.kind === "step" || n.kind === "external") {
    actions.append(
      button(n.status === "done" ? "Mark not done" : "Mark done", "secondary", () => post({ type: "editNode", id: n.id, op: "toggleDone" })),
    );
  }
  actions.append(button("Remove", "secondary danger", () => post({ type: "editNode", id: n.id, op: "remove" }), "Remove this node and its edges (Undo brings it back)"));
  // Actions right under the title, so they stay visible when the details scroll.
  box.querySelector("h3")?.after(actions);
}

/** When every planned piece is typed: the two natural next steps. */
function renderDoneBanner(s: PanelState, p: { done: number; total: number } | undefined): void {
  const banner = $("done-banner");
  const done = !!p?.total && p.done === p.total && !s.status.busy;
  banner.hidden = !done;
  if (!done || banner.dataset.total === String(p!.total)) return;
  banner.dataset.total = String(p!.total);
  banner.innerHTML = "";
  banner.append(
    el("span", "", `✓ All ${p!.total} planned pieces are typed.`),
    button("Review the file", "secondary", () => post({ type: "send", text: FILE_REVIEW_REQUEST }), "Ask for a review of the whole file against the plan"),
    button("Plan tests", "secondary", () => post({ type: "send", text: TESTS_REQUEST }), "Ask the assistant to add test nodes to the plan"),
  );
}

const FILE_REVIEW_REQUEST =
  "I typed every piece of the plan. Review the whole file against the plan: correctness, the edge cases in the notes, error handling, and anything clearly better. Point to the lines; don't rewrite the code for me.";
const TESTS_REQUEST =
  "Plan the tests for this file: add test nodes to the graph (kind test) with the cases each one checks, and tell me where the tests should live in this project.";

function hintRequest(name: string): string {
  return `Give me a hint for \`${name}\`: the steps to implement it and the APIs to use. Don't write the code for me.`;
}

function reviewRequest(name: string): string {
  return `Review my code for \`${name}\`: is it correct, does it handle the edge cases in the plan, and is there a clearly better way? Point to the lines; don't rewrite it for me.`;
}

// ---------------------------------------------------------------- header

function pill(text: string, cls: string, title: string, onClick?: () => void): HTMLElement {
  const p = el("span", `pill ${cls}${onClick ? " clickable" : ""}`);
  p.textContent = text;
  p.title = title;
  if (onClick) p.addEventListener("click", onClick);
  return p;
}

function renderHeader(s: PanelState): void {
  const file = $("file");
  file.textContent = s.file ?? "No file";
  file.title = `${s.file ? `${s.file} (${s.language})` : "Open a source file"}\nClick to open another planned file`;
  const st = s.status;
  const pills = $("pills");
  pills.innerHTML = "";
  const cfg = () => post({ type: "openConfig" });
  pills.append(
    pill(
      "LLM",
      st.llm === "ready" ? "ok" : st.llm === "error" ? "bad" : "warn",
      st.llm === "ready" ? "LLM configured" : st.llm === "error" ? "The last LLM request failed: click to set up the LLM" : "LLM not configured: click to set it up",
      st.llm === "ready" ? undefined : () => post({ type: "setup" }),
    ),
    pill(
      "Jev",
      st.jev === "ready" ? "ok" : st.jev === "off" ? "off" : st.jev === "error" ? "bad" : "warn",
      st.triage === "jev" ? (st.jev === "ready" ? "Jev triages each heartbeat" : "Jev not configured: click to open .env") : `Heartbeat triage: ${st.triage}`,
      st.jev === "missing" ? cfg : undefined,
    ),
    pill(
      st.heartbeat === "on" ? `♥ ${st.heartbeatSeconds}s` : "♥ paused",
      st.heartbeat === "on" ? "ok" : "off",
      `Heartbeat ${st.heartbeat}${st.lastBeat ? ` · last ${time(st.lastBeat)}` : ""}${st.lastVerdict ? `\n${st.lastVerdict}` : ""}`,
    ),
  );
  const hasGraph = !!s.graph?.nodes.length;
  const draft = $<HTMLButtonElement>("btn-draft");
  draft.textContent = hasGraph ? "Redraft" : "Draft";
  draft.disabled = !s.supported || !s.moduleString || !!st.busy;
  $<HTMLButtonElement>("btn-sync").disabled = !hasGraph || !!st.busy;
  $<HTMLButtonElement>("btn-undo").disabled = !s.canUndo || !!st.busy;
  $<HTMLButtonElement>("btn-beat").disabled = !s.supported || st.heartbeat === "off";
  $("btn-pause").textContent = st.heartbeat === "on" ? "Pause" : "Resume";

  const doc = $("docstring");
  doc.classList.toggle("hint", !s.moduleString);
  if (!s.supported) {
    doc.textContent = s.unsaved
      ? "Save the file to plan it."
      : s.file
        ? "This language is not supported yet (Python, TypeScript, JavaScript, Go, Rust, Java)."
        : "";
  } else if (!s.moduleString) {
    doc.textContent = "Describe the module at the top of the file to start.";
  } else {
    doc.textContent = s.moduleString + (s.moduleStringClosed ? "" : " …");
    const drafted = s.graph?.moduleString?.trim();
    if (hasGraph && s.moduleStringClosed && drafted && drafted !== s.moduleString.trim()) {
      const note = el("span", "changed", "  · docstring changed since the draft, ");
      note.appendChild(button("redraft?", "link", () => post({ type: "draft" })));
      doc.appendChild(note);
    }
  }
}

const EXAMPLE_DOCSTRINGS: Record<string, string> = {
  python: '"""Fetch open issues for a GitHub repository\nand cache them on disk with ETags."""',
  javascript: "/**\n * Rate-limit outgoing HTTP requests with a\n * token bucket shared across callers.\n */",
  go: "// Package cache stores HTTP responses on disk\n// and revalidates them with ETags.\npackage cache",
  rust: "//! Parse a CSV file of transactions and\n//! report the balance of each account.",
  java: "/**\n * Schedules meetings for a team: finds free\n * slots across calendars and books them.\n */\npackage com.example.scheduler;",
};

function renderEmpty(s: PanelState): void {
  const box = $("graph-empty");
  const hasGraph = !!s.graph?.nodes.length;
  box.hidden = hasGraph;
  $("cy").style.visibility = hasGraph && tab === "graph" ? "visible" : "hidden";
  $("steps").hidden = !hasGraph || tab !== "steps";
  if (hasGraph) return;
  box.innerHTML = "";
  if (!s.file) {
    box.append(el("div", "", "Open a Python, TypeScript, JavaScript, Go, Rust or Java file to plan it here."));
  } else if (s.unsaved) {
    box.append(el("div", "", "Save the file first: the graph is kept with the file's path."));
  } else if (!s.supported) {
    box.append(el("div", "", `${esc(s.language)} files are not supported yet.`));
  } else if (s.status.busy) {
    box.append(el("div", "", `<span class="spinner"></span> ${esc(s.status.busy)}`));
  } else if (!s.moduleString) {
    const example = EXAMPLE_DOCSTRINGS[s.language ?? ""] ?? EXAMPLE_DOCSTRINGS.javascript;
    box.append(
      el("div", "", "<b>Start with the module docstring.</b> Describe what this file should do at its top; the graph is drafted from it."),
      el("pre", "", esc(example)),
    );
  } else if (!s.moduleStringClosed) {
    box.append(el("div", "", "Finish the docstring (close it) and the graph will be drafted, or press <b>Draft</b>."));
  } else if (s.status.llm !== "ready") {
    box.append(el("div", "", "Set up the LLM to draft the graph: choose the endpoint, enter the key and pick a model."));
    box.append(button("Set up the LLM…", "", () => post({ type: "setup" })), button("Open .env", "ghost", () => post({ type: "openConfig" })));
  } else {
    box.append(el("div", "", "No graph yet."));
    box.append(button("Draft the graph", "", () => post({ type: "draft" })));
  }
}

// ---------------------------------------------------------------- feed

const rendered = new Map<string, { sig: string; node: HTMLElement }>();

const ISSUE_ICON: Record<string, string> = {
  typo: "✎",
  syntax: "⛔",
  logic_error: "⚠",
  api_misuse: "⚙",
  better_implementation: "💡",
  missing_edge_case: "◇",
  deviates_from_graph: "⤳",
  security: "🔒",
  other: "•",
};

function resourceList(items: Resource[]): HTMLElement {
  const ul = el("ul");
  for (const r of items) {
    const li = el("li");
    const a = el("a", "", esc(r.title)) as HTMLAnchorElement;
    a.href = r.url;
    a.title = r.url;
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      post({ type: "openLink", url: r.url });
    });
    li.append(a, el("span", "chip", r.type));
    if (r.verified === "unverified") li.append(el("span", "unverified", " (link not checked)"));
    li.append(el("span", "why", esc(r.why)));
    ul.appendChild(li);
  }
  return ul;
}

function renderItem(f: FeedItem): HTMLElement {
  const box = el("div", `item ${f.kind}`);
  const meta = (label: string) => el("div", "meta", `<span>${label}</span><span class="spacer"></span><span class="ts">${time(f.ts)}</span>`);
  switch (f.kind) {
    case "user":
      box.textContent = f.text;
      break;
    case "assistant": {
      const head = meta(f.mode === "draft" ? "Drafted" : f.mode === "sync" ? "Synced" : f.mode === "heartbeat" ? "Heartbeat" : "Assistant");
      if (f.usage) {
        const ts = head.querySelector(".ts") as HTMLElement | null;
        if (ts) ts.title = `${f.usage.prompt.toLocaleString()} prompt + ${f.usage.completion.toLocaleString()} completion tokens`;
      }
      box.append(head);
      box.append(el("div", "md", md(f.text)));
      if (f.changes) {
        const c = f.changes;
        const parts = [
          c.added.length ? `+${c.added.length} node${c.added.length > 1 ? "s" : ""}` : "",
          c.updated.length ? `~${c.updated.length} updated` : "",
          c.removed.length ? `−${c.removed.length} removed` : "",
          c.edgesAdded ? `+${c.edgesAdded} edge${c.edgesAdded > 1 ? "s" : ""}` : "",
          c.edgesRemoved ? `−${c.edgesRemoved} edge${c.edgesRemoved > 1 ? "s" : ""}` : "",
        ].filter(Boolean);
        if (parts.length) {
          const line = el("div", "changes", `Graph: ${parts.join(", ")}`);
          const why = Object.entries(c.removalReasons ?? {}).map(([id, r]) => `${id} removed: ${r}`);
          if (why.length) line.title = why.join("\n");
          box.append(line);
        }
      }
      break;
    }
    case "interrupt": {
      box.classList.add(`sev-${f.severity}`, f.status);
      box.append(
        meta(
          `${ISSUE_ICON[f.issue] ?? "•"} ${f.issue.replace(/_/g, " ")} · line ${f.line + 1}${f.status !== "open" ? ` · ${f.status}` : ""}`,
        ),
      );
      box.append(el("div", "title", esc(f.title)));
      box.append(el("div", "md", md(f.message)));
      if (f.status === "open") {
        const actions = el("div", "actions");
        actions.append(
          button("Show line", "secondary", () => post({ type: "goto", line: f.line, endLine: f.endLine })),
          button("Explain more", "secondary", () => post({ type: "explain", id: f.id })),
          button("Got it", "secondary", () => post({ type: "dismiss", id: f.id }), "Dismiss; it will not be raised again"),
        );
        box.append(actions);
      }
      break;
    }
    case "resources":
      box.append(meta(`📚 Learn: ${esc(f.topic)}`));
      box.append(resourceList(f.items));
      break;
    case "question": {
      box.append(meta("Question"));
      box.append(el("div", "md", md(f.question)));
      const actions = el("div", "actions");
      if (f.answered) {
        actions.append(el("span", "muted", `You answered: ${esc(f.answered)}`));
      } else {
        for (const o of f.options) actions.append(button(o, "secondary", () => post({ type: "answer", id: f.id, option: o })));
        actions.append(button("Answer…", "link", () => focusInput(`Re "${f.question}": `)));
      }
      box.append(actions);
      break;
    }
    case "code_ref": {
      const link = button(`${f.path}:${f.line + 1}${f.endLine !== undefined ? `-${f.endLine + 1}` : ""}`, "link", () =>
        post({ type: "goto", path: f.path, line: f.line, endLine: f.endLine }),
      );
      box.append(el("span", "", "↪ "), link, el("span", "", ` — ${esc(f.note)}`));
      break;
    }
    case "system":
      box.classList.add(f.level);
      box.append(el("div", "md", md(f.text)));
      break;
  }
  return box;
}

function welcome(): HTMLElement {
  return el(
    "div",
    "welcome",
    "<b>How this works</b><ol>" +
      "<li>Describe the module in its docstring at the top of the file.</li>" +
      "<li>The assistant drafts an implementation graph from it and your project.</li>" +
      "<li>Tell it what to change in the box below; it edits the graph and sums up.</li>" +
      "<li>Type the code yourself. A heartbeat checks your progress and interrupts only when something matters.</li></ol>",
  );
}

function renderFeed(feed: FeedItem[], fileChanged: boolean): void {
  const box = $("feed");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  if (fileChanged) {
    box.innerHTML = "";
    rendered.clear();
  }
  if (!feed.length) {
    box.innerHTML = "";
    rendered.clear();
    box.appendChild(welcome());
    return;
  }
  box.querySelector(".welcome")?.remove();
  const ids = new Set(feed.map((f) => f.id));
  for (const [id, r] of rendered) {
    if (!ids.has(id)) {
      r.node.remove();
      rendered.delete(id);
    }
  }
  let added = false;
  let prev: HTMLElement | undefined;
  for (const f of feed) {
    const sig = JSON.stringify(f);
    const r = rendered.get(f.id);
    if (r && r.sig === sig) {
      prev = r.node;
      continue;
    }
    const node = renderItem(f);
    if (r) {
      r.node.replaceWith(node);
    } else {
      if (prev) prev.after(node);
      else box.prepend(node);
      added = true;
    }
    rendered.set(f.id, { sig, node });
    prev = node;
  }
  if ((added && nearBottom) || fileChanged) {
    box.scrollTop = box.scrollHeight;
  }
}

// ---------------------------------------------------------------- input

const input = $<HTMLTextAreaElement>("input");

function focusInput(text?: string): void {
  if (text !== undefined) {
    input.value = text;
  }
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  autosize();
}

function autosize(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(140, input.scrollHeight + 2)}px`;
}

function send(): void {
  const text = input.value.trim();
  if (!text || !state?.supported) return;
  post({ type: "send", text });
  input.value = "";
  autosize();
}

input.addEventListener("input", autosize);
input.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    send();
  }
});
$("btn-send").addEventListener("click", send);
$("btn-draft").addEventListener("click", () => post({ type: "draft" }));
$("btn-sync").addEventListener("click", () => post({ type: "sync" }));
$("btn-undo").addEventListener("click", () => post({ type: "undo" }));
$("btn-beat").addEventListener("click", () => post({ type: "beatNow" }));
$("btn-pause").addEventListener("click", () => post({ type: "toggleHeartbeat" }));
$("btn-config").addEventListener("click", () => post({ type: "openConfig" }));
$("btn-stop").addEventListener("click", () => post({ type: "cancel" }));
$("file").addEventListener("click", () => post({ type: "pickFile" }));
$("btn-fit").addEventListener("click", () => layout());
$("docstring").addEventListener("click", (ev) => {
  if ((ev.target as HTMLElement).tagName !== "BUTTON") $("docstring").classList.toggle("expanded");
});

function setTab(t: "graph" | "steps"): void {
  tab = t;
  persist();
  $("tab-graph").classList.toggle("active", t === "graph");
  $("tab-steps").classList.toggle("active", t === "steps");
  if (state) renderEmpty(state);
  if (t === "steps") renderSteps(state?.graph);
  else requestAnimationFrame(layout);
}
$("tab-graph").addEventListener("click", () => setTab("graph"));
$("tab-steps").addEventListener("click", () => setTab("steps"));

// Links inside markdown open in the browser through the host.
document.addEventListener("click", (ev) => {
  const a = (ev.target as HTMLElement).closest("a");
  if (a && a.closest(".md")) {
    ev.preventDefault();
    const href = a.getAttribute("href");
    if (href && /^https?:/.test(href)) post({ type: "openLink", url: href });
  }
});

new ResizeObserver(() => {
  cy.resize();
  // Keep the whole graph visible when the panel or the details box changes size.
  if (!userViewport && tab === "graph" && cy.nodes().length) fit();
}).observe($("graph-wrap"));
$("cy").addEventListener("wheel", () => (userViewport = true), { passive: true });
cy.on("tapstart", (ev) => {
  if (ev.target === cy) userViewport = true; // a drag on the background pans
});

// Re-color when the VS Code theme changes.
new MutationObserver(() => cy.style(graphStyle())).observe(document.body, { attributes: true, attributeFilter: ["class"] });

// ---------------------------------------------------------------- state

function render(s: PanelState): void {
  const fileChanged = s.file !== lastFile;
  lastFile = s.file;
  state = s;
  if (fileChanged) {
    selected = s.graph?.nodes.some((n) => n.id === selected) ? selected : undefined;
    renderStream(undefined); // a reply streaming for the other file does not belong here
  }
  renderHeader(s);
  const p = s.graph?.nodes.length ? progress(s.graph) : undefined;
  $("tab-steps").textContent = p?.total ? `Steps ${p.done}/${p.total}` : "Steps";
  $("tab-steps").title = p?.total ? `${p.done} of ${p.total} pieces typed${p.next ? `; next: ${p.next.label}` : ""}` : "";
  renderDoneBanner(s, p);
  renderEmpty(s);
  renderGraph(s.graph);
  if (tab === "steps") renderSteps(s.graph);
  if (selected && !s.graph?.nodes.some((n) => n.id === selected)) selected = undefined;
  renderDetails();
  renderFeed(s.feed, fileChanged);
  const busy = $("busy");
  busy.hidden = !s.status.busy;
  $("busy-text").textContent = s.status.busy ?? "";
  input.disabled = !s.supported;
}

// The reply as it streams: a temporary item after the last feed item.
const streamEl = el("div", "item assistant streaming");
function renderStream(text: string | undefined): void {
  const box = $("feed");
  if (!text) {
    streamEl.remove();
    return;
  }
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  streamEl.innerHTML = md(text);
  box.querySelector(".welcome")?.remove();
  box.appendChild(streamEl); // keeps it last
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

window.addEventListener("message", (ev: MessageEvent<ToPanel>) => {
  const m = ev.data;
  if (m.type === "state") render(m.state);
  else if (m.type === "stream") renderStream(m.text);
  else if (m.type === "focusInput") focusInput(m.text);
  else if (m.type === "selectNode") select(m.id);
});

setTab(tab);
post({ type: "ready" });
