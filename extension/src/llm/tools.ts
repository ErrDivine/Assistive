// The tools the LLM uses. Three families:
//   look      – read-only project context (outline, files, search, diagnostics, edits, graph)
//   graph     – batch edits to the implementation graph, validated with actionable errors
//   talk      – what reaches the programmer besides the summary: resources, questions,
//               code pointers, and (heartbeat only) interrupts or standing down
// Every tool returns plain text written for the model to read.

import { type Baseline, type EditTracker } from "../code/changes";
import { isSecretPath, normalizeRel, numberLines, type WorkspaceAccess } from "../code/context";
import { type FileOutline, formatOutline, symbolAt } from "../code/outline";
import { compactGraph, type EdgeInput, type GraphEditor, type NodeInput, type NodeUpdate } from "../graph/model";
import type { LinkCheck } from "../resources/links";
import {
  type AgentMode,
  EDGE_KINDS,
  type IssueKind,
  type NewFeedItem,
  NODE_KINDS,
  type Resource,
  type ResourceType,
} from "../types";
import type { AgentTool } from "./agent";
import type { JsonSchema } from "./schema";

export interface ToolEnv {
  ws: WorkspaceAccess;
  /** Workspace-relative path of the file the graph belongs to. */
  file: string;
  language: string;
  /** Current text of that file (unsaved edits included). */
  liveText(): string;
  outlineOf(rel: string, text: string): Promise<FileOutline>;
  editor: GraphEditor;
  edits: EditTracker;
  checkLinks(items: Resource[]): Promise<LinkCheck>;
  /** Show something to the programmer in the panel feed. */
  emit(item: NewFeedItem): void;
}

const MAX_READ_LINES = 400;

export const ISSUE_KINDS: IssueKind[] = [
  "typo",
  "syntax",
  "logic_error",
  "api_misuse",
  "better_implementation",
  "missing_edge_case",
  "deviates_from_graph",
  "security",
  "other",
];

const RESOURCE_TYPES: ResourceType[] = ["docs", "tutorial", "article", "video", "book", "reference", "course"];

type Tool = AgentTool<Record<string, unknown>>;

function tool<A>(t: AgentTool<A>): Tool {
  return t as unknown as Tool;
}

const str = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: "string", description, ...extra });
const int = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: "integer", description, ...extra });

// ---------------------------------------------------------------- shared schemas

const NODE_KIND_HELP =
  "module: the file itself; class; function; method (symbol 'Class.method'); data: a dataclass/record/typed dict/interface; " +
  "constant; test: a test function; external: a library, service or other project module this file relies on (not typed here); " +
  "step: a unit of work that is not a named symbol (e.g. 'validate input inside main').";

const nodeFields: Record<string, JsonSchema> = {
  id: str("Stable snake_case id, unique in this graph: 'parse_args', 'cache_get'. Reuse ids exactly as get_graph shows them.", {
    minLength: 1,
    maxLength: 48,
  }),
  kind: str(`What the node is. ${NODE_KIND_HELP}`, { enum: NODE_KINDS }),
  symbol: str(
    "The exact name the programmer will type, dotted for members: 'parse_args', 'Cache.get'. Omit for step and external nodes.",
  ),
  signature: str(
    "Planned signature in the file's language, with types: 'def get(self, key: str) -> bytes | None' or " +
      "'function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T>'. For data nodes list the fields; for externals the API used.",
  ),
  description: str("What it is responsible for, in one or two sentences. Say what, not how to type it.", { minLength: 1 }),
  notes: {
    type: "array",
    maxItems: 8,
    items: { type: "string" },
    description:
      "Technical considerations, one per item: edge cases, errors to raise or handle, complexity, library calls to use, invariants, " +
      "concurrency. Short sentences; no code blocks.",
  },
  order: int("Suggested typing order, 1 = type first. Dependencies come before the code that uses them.", { minimum: 1, maximum: 99 }),
  label: str("Short display name if different from the symbol (max ~3 words)."),
};

const edgeSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to", "kind"],
  properties: {
    from: str("Source node id."),
    to: str("Target node id."),
    kind: str(
      "calls: from invokes to; uses: reads a constant/type/external API; contains: class contains method, module contains symbol; " +
        "creates: constructs an instance; reads / writes: data flow to or from storage/state; returns: from produces a value of to; " +
        "depends: must exist first (ordering only).",
      { enum: EDGE_KINDS },
    ),
    label: str("Optional few-word detail shown on the edge, e.g. 'on cache miss'."),
  },
};

// ---------------------------------------------------------------- look

function lookTools(env: ToolEnv): Tool[] {
  const resolve = (p: unknown): { rel?: string; error?: string } => {
    if (p === undefined || p === "") {
      return { rel: env.file };
    }
    const rel = normalizeRel(env.ws.root, String(p));
    if (rel === undefined) {
      return { error: `error: '${String(p)}' is outside the workspace. Use a workspace-relative path such as '${env.file}'.` };
    }
    if (isSecretPath(rel)) {
      return { error: `error: '${rel}' looks like a secrets or credentials file; it is never read.` };
    }
    return { rel };
  };
  const textOf = async (rel: string) => (rel === env.file ? env.liveText() : await env.ws.read(rel));

  return [
    tool<{ path?: string }>({
      name: "get_file_outline",
      description:
        "Outline of a source file: its module docstring, imports, and every class/function/method/constant with line range, " +
        "signature, first docstring line and whether the body is still a stub. Cheapest way to see what exists. " +
        "Defaults to the file being worked on.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { path: str("Workspace-relative path; omit for the current file.") },
      },
      async run({ path }) {
        const r = resolve(path);
        if (r.error) return r.error;
        const text = await textOf(r.rel!);
        if (text === undefined) return `error: no file '${r.rel}'. Use list_files to find the right path.`;
        const o = await env.outlineOf(r.rel!, text);
        const head = o.moduleString ? `Module docstring (L${o.moduleString.startLine + 1}-${o.moduleString.endLine + 1}):\n${o.moduleString.text}\n\n` : "";
        return `${r.rel} (${text.split("\n").length} lines)\n${head}${formatOutline(o, { docstrings: true })}`;
      },
    }),
    tool<{ path?: string; start_line?: number; end_line?: number }>({
      name: "read_file",
      description:
        `Read lines of a workspace file with 1-based line numbers (at most ${MAX_READ_LINES} lines per call). ` +
        "For the current file this is the live editor text including unsaved typing. Use get_file_outline first to find the range you need.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: str("Workspace-relative path; omit for the current file."),
          start_line: int("First line, 1-based (default 1).", { minimum: 1 }),
          end_line: int("Last line, inclusive.", { minimum: 1 }),
        },
      },
      async run({ path, start_line, end_line }) {
        const r = resolve(path);
        if (r.error) return r.error;
        const text = await textOf(r.rel!);
        if (text === undefined) return `error: no file '${r.rel}'. Use list_files to find the right path.`;
        const total = text.split(/\r?\n/).length;
        const start = Math.min(start_line ?? 1, total);
        const end = Math.min(end_line ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1, total);
        const more = end < total ? `\n(${total - end} more lines; call again with start_line=${end + 1})` : "";
        return `${r.rel} lines ${start}-${end} of ${total}:\n${numberLines(text, start, end)}${more}`;
      },
    }),
    tool<{ query: string; is_regex?: boolean; glob?: string; max_results?: number }>({
      name: "search_code",
      description:
        "Search the workspace text for a word, identifier or regex (case-sensitive) and get matching lines as path:line: text. " +
        "Use it to find how something is used or defined elsewhere in the project before planning around it.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: str("Text or regular expression to find.", { minLength: 1 }),
          is_regex: { type: "boolean", description: "Treat query as a JavaScript regular expression (default false)." },
          glob: str("Limit to files matching this glob, e.g. '**/*.py' or 'src/**'."),
          max_results: int("Default 20.", { minimum: 1, maximum: 50 }),
        },
      },
      async run({ query, is_regex, glob, max_results }) {
        if (is_regex) {
          try {
            new RegExp(query);
          } catch (err) {
            return `error: invalid regex: ${(err as Error).message}`;
          }
        }
        const max = max_results ?? 20;
        const hits = await env.ws.search(query, { regex: !!is_regex, glob, max: max + 1 });
        const visible = hits.filter((h) => !isSecretPath(h.path)).slice(0, max);
        if (!visible.length) return `No matches for ${is_regex ? "regex " : ""}'${query}'${glob ? ` in ${glob}` : ""}.`;
        const lines = visible.map((h) => `${h.path}:${h.line + 1}: ${h.text.trim().slice(0, 200)}`);
        return lines.join("\n") + (hits.length > max ? `\n(more matches; narrow the query or glob)` : "");
      },
    }),
    tool<{ glob?: string; max?: number }>({
      name: "list_files",
      description: "List workspace files (vendored, virtualenv and build folders excluded), optionally filtered by a glob.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          glob: str("Glob such as '**/*.py', 'tests/**' (default: all files)."),
          max: int("Default 200.", { minimum: 1, maximum: 300 }),
        },
      },
      async run({ glob, max }) {
        const files = (await env.ws.list(glob, (max ?? 200) + 1)).filter((f) => !isSecretPath(f));
        if (!files.length) return `No files${glob ? ` match ${glob}` : ""}.`;
        const shown = files.slice(0, max ?? 200);
        return shown.join("\n") + (files.length > shown.length ? "\n(more files; use a narrower glob)" : "");
      },
    }),
    tool<{ path?: string }>({
      name: "get_diagnostics",
      description:
        "Errors and warnings that the editor's language tooling (type checker, linter) currently reports, with 1-based lines. " +
        "Defaults to the current file; pass path='*' for the whole workspace.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { path: str("Workspace-relative path, '*' for all files; omit for the current file.") },
      },
      async run({ path }) {
        let rel: string | undefined;
        if (path !== "*") {
          const r = resolve(path);
          if (r.error) return r.error;
          rel = r.rel;
        }
        const diags = env.ws.diagnostics(rel).slice(0, 60);
        if (!diags.length) return `No diagnostics${rel ? ` for ${rel}` : ""}.`;
        return diags.map((d) => `${d.path}:${d.line + 1} ${d.severity}${d.source ? ` (${d.source})` : ""}: ${d.message}`).join("\n");
      },
    }),
  ];
}

function graphReadTools(env: ToolEnv): Tool[] {
  return [
    tool<Record<string, never>>({
      name: "get_graph",
      description:
        "The current implementation graph of this file: every node (id, kind, status, line, symbol, signature, description, notes) " +
        "in typing order, and every edge. Statuses: planned (not typed), stubbed (placeholder body), done, attention (flagged).",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      run() {
        const g = env.editor.graph;
        return `Graph for ${g.file} (revision ${g.revision}):\n${compactGraph(g)}`;
      },
    }),
    tool<{ since?: Baseline }>({
      name: "get_recent_edits",
      description:
        "What the programmer changed in the current file, as a diff with new-file line numbers (+ added, - removed). " +
        "since='last_heartbeat' (default) shows the latest typing; 'graph_created' shows everything since the graph was drafted.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { since: str("Baseline to diff against.", { enum: ["last_heartbeat", "graph_created"] }) },
      },
      run({ since }) {
        const d = env.edits.diff(env.file, env.liveText(), since ?? "last_heartbeat", 8000);
        return d || `No changes since ${since === "graph_created" ? "the graph was created" : "the last heartbeat"}.`;
      },
    }),
  ];
}

// ---------------------------------------------------------------- graph edits

function graphEditTools(env: ToolEnv): Tool[] {
  const tally = (lines: string[]) =>
    `${lines.join("\n")}\nGraph now has ${env.editor.graph.nodes.length} nodes and ${env.editor.graph.edges.length} edges.`;
  return [
    tool<{ nodes: NodeInput[] }>({
      name: "add_nodes",
      description:
        "Add planned pieces to the graph, several at once. Each node is something the programmer will type (or an external " +
        "dependency). Fails per node, with the reason, if the id exists or a field is invalid; the others are still added.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["nodes"],
        properties: {
          nodes: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: { type: "object", additionalProperties: false, required: ["id", "kind", "description"], properties: nodeFields },
          },
        },
      },
      run({ nodes }) {
        return tally(env.editor.addNodes(nodes));
      },
    }),
    tool<{ updates: NodeUpdate[] }>({
      name: "update_nodes",
      description:
        "Change existing nodes, several at once. 'set' replaces the given fields (notes replaces the whole list); 'append_notes' adds notes. " +
        "Use set.attention to flag a node with a short reason (status becomes attention), and set.attention='' to clear it.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["updates"],
        properties: {
          updates: {
            type: "array",
            minItems: 1,
            maxItems: 30,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id"],
              properties: {
                id: str("Id of the node to change."),
                set: {
                  type: "object",
                  additionalProperties: false,
                  description: "Fields to replace.",
                  properties: {
                    kind: nodeFields.kind,
                    label: nodeFields.label,
                    symbol: nodeFields.symbol,
                    signature: nodeFields.signature,
                    description: str("New description."),
                    notes: nodeFields.notes,
                    order: nodeFields.order,
                    status: str("Only for step/external nodes; symbol statuses follow the code automatically.", {
                      enum: ["planned", "stubbed", "done", "attention"],
                    }),
                    attention: str("Why the node needs the programmer's attention; '' clears the flag."),
                  },
                },
                append_notes: { type: "array", maxItems: 8, items: { type: "string" }, description: "Notes to add." },
              },
            },
          },
        },
      },
      run({ updates }) {
        return tally(env.editor.updateNodes(updates));
      },
    }),
    tool<{ ids: string[]; reason: string }>({
      name: "remove_nodes",
      description: "Remove nodes (and their edges) that are no longer part of the plan.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["ids", "reason"],
        properties: {
          ids: { type: "array", minItems: 1, maxItems: 30, items: { type: "string" }, description: "Node ids to remove." },
          reason: str("Why, in a few words (shown in the change log).", { minLength: 1 }),
        },
      },
      run({ ids }) {
        return tally(env.editor.removeNodes(ids));
      },
    }),
    tool<{ edges: EdgeInput[] }>({
      name: "connect",
      description: "Add edges between existing nodes, several at once. Re-adding an existing edge only updates its label.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["edges"],
        properties: { edges: { type: "array", minItems: 1, maxItems: 40, items: edgeSchema } },
      },
      run({ edges }) {
        return tally(env.editor.connect(edges));
      },
    }),
    tool<{ edges: { from: string; to: string; kind?: string }[] }>({
      name: "disconnect",
      description: "Remove edges. Without kind, every edge between the two nodes in that direction is removed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["edges"],
        properties: {
          edges: {
            type: "array",
            minItems: 1,
            maxItems: 40,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["from", "to"],
              properties: { from: str("Source node id."), to: str("Target node id."), kind: str("Edge kind.", { enum: EDGE_KINDS }) },
            },
          },
        },
      },
      run({ edges }) {
        return tally(env.editor.disconnect(edges));
      },
    }),
  ];
}

// ---------------------------------------------------------------- talk

function talkTools(env: ToolEnv): { resources: Tool; ask: Tool; point: Tool } {
  const resources = tool<{ topic: string; resources: Resource[] }>({
    name: "recommend_resources",
    description:
      "Show the programmer the best 1–4 learning resources for a concept they need now (shown as links in the panel). " +
      "Prefer official documentation, then well-known tutorials or articles; use deep links to the exact page or section. " +
      "Only URLs you are confident exist: links are checked and dead ones are dropped.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["topic", "resources"],
      properties: {
        topic: str("The concept, e.g. 'HTTP conditional requests with ETag'.", { minLength: 1 }),
        resources: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "url", "type", "why"],
            properties: {
              title: str("Page title.", { minLength: 1 }),
              url: str("Full https URL.", { minLength: 8 }),
              type: str("Kind of resource.", { enum: RESOURCE_TYPES }),
              why: str("One sentence: what the programmer will learn there for this task.", { minLength: 1 }),
            },
          },
        },
      },
    },
    async run({ topic, resources: items }) {
      const { kept, dropped } = await env.checkLinks(items);
      const why = dropped.map((d) => `${d.url} (${d.reason})`).join(", ");
      if (!kept.length) {
        return `error: none of the links could be used: ${why}. Recommend other pages you are sure exist.`;
      }
      env.emit({ kind: "resources", topic, items: kept });
      return `ok: showed ${kept.length} resource(s) on '${topic}'.${dropped.length ? ` Dropped: ${why}.` : ""}`;
    },
  });

  const ask = tool<{ question: string; options?: string[] }>({
    name: "ask_programmer",
    description:
      "Ask the programmer a short question about a design decision only they can make (shown with clickable options). " +
      "Their answer arrives as a later message; do not wait for it. Make a sensible default choice in the graph meanwhile.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        question: str("One sentence.", { minLength: 1 }),
        options: { type: "array", maxItems: 4, items: { type: "string" }, description: "2–4 short answers to click." },
      },
    },
    run({ question, options }) {
      env.emit({ kind: "question", question, options: (options ?? []).filter((o) => o.trim()).slice(0, 4) });
      return "ok: question shown. Continue with your default; the answer will come as a later message.";
    },
  });

  const point = tool<{ path?: string; line: number; end_line?: number; note: string }>({
    name: "point_to_code",
    description: "Show the programmer a clickable reference to specific lines with a short note (e.g. where to make a change).",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["line", "note"],
      properties: {
        path: str("Workspace-relative path; omit for the current file."),
        line: int("First line, 1-based.", { minimum: 1 }),
        end_line: int("Last line, 1-based.", { minimum: 1 }),
        note: str("What to look at there, one sentence.", { minLength: 1 }),
      },
    },
    run({ path, line, end_line, note }) {
      const rel = path ? normalizeRel(env.ws.root, path) : env.file;
      if (!rel) return `error: '${path}' is outside the workspace.`;
      env.emit({ kind: "code_ref", path: rel, line: line - 1, endLine: end_line ? end_line - 1 : undefined, note });
      return "ok: reference shown.";
    },
  });
  return { resources, ask, point };
}

function heartbeatTools(env: ToolEnv): Tool[] {
  let interrupted = false;
  return [
    tool<{ title: string; message: string; line: number; end_line?: number; issue: IssueKind; severity: number }>({
      name: "interrupt_programmer",
      description:
        "Interrupt the programmer about one concrete problem in what they just typed: the panel shows it, the line gets a squiggle, " +
        "and a notification appears if the panel is hidden. Call at most once per heartbeat; put the most important problem first. " +
        "Explain the problem and the direction of the fix in at most four sentences; do not write the fixed code.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "message", "line", "issue", "severity"],
        properties: {
          title: str("At most ~8 words, e.g. 'Off-by-one in the page loop'.", { minLength: 1, maxLength: 80 }),
          message: str("What is wrong, why it matters, and what to change (markdown, short).", { minLength: 1 }),
          line: int("1-based line where the problem is.", { minimum: 1 }),
          end_line: int("Last line of the problem, 1-based.", { minimum: 1 }),
          issue: str("Kind of problem.", { enum: ISSUE_KINDS }),
          severity: int("1 = worth knowing, 2 = fix before moving on, 3 = will break / blocks progress.", { minimum: 1, maximum: 3 }),
        },
      },
      run(a, ctx) {
        if (interrupted) {
          return "error: you already interrupted in this heartbeat; one interruption at a time.";
        }
        const lines = env.liveText().split(/\r?\n/);
        if (a.line > lines.length) {
          return `error: line ${a.line} is past the end of the file (${lines.length} lines).`;
        }
        interrupted = true;
        env.emit({
          kind: "interrupt",
          title: a.title,
          message: a.message,
          line: a.line - 1,
          endLine: a.end_line && a.end_line >= a.line ? Math.min(a.end_line, lines.length) - 1 : undefined,
          issue: a.issue,
          severity: Math.min(3, Math.max(1, Math.round(a.severity))) as 1 | 2 | 3,
          status: "open",
          lineText: lines[a.line - 1],
        });
        ctx.stop = { reason: `interrupted: ${a.title}` };
        return "ok: the programmer was interrupted.";
      },
    }),
    tool<{ reason: string }>({
      name: "stand_down",
      description:
        "Decide not to interrupt: the code is fine, unfinished but on track, or the issue is too minor. Ends the heartbeat.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["reason"],
        properties: { reason: str("A few words, e.g. 'still typing the loop'.", { minLength: 1 }) },
      },
      run({ reason }, ctx) {
        ctx.stop = { reason };
        return "ok.";
      },
    }),
  ];
}

// ---------------------------------------------------------------- per mode

/** The tool set each kind of turn may use. */
export function toolsFor(mode: AgentMode, env: ToolEnv): Tool[] {
  const look = lookTools(env);
  const [getGraph, recentEdits] = graphReadTools(env);
  const edit = graphEditTools(env);
  const talk = talkTools(env);
  switch (mode) {
    case "draft":
      return [...look, getGraph, ...edit, talk.resources, talk.ask];
    case "chat":
      return [...look, getGraph, recentEdits, ...edit, talk.resources, talk.ask, talk.point];
    case "sync":
      return [...look, getGraph, recentEdits, ...edit];
    case "heartbeat":
      return [...look, getGraph, recentEdits, edit.find((t) => t.name === "update_nodes")!, talk.resources, ...heartbeatTools(env)];
  }
}

/** Line and enclosing symbol for prompts: "line 42, in def fetch(repo)". */
export function cursorDescription(o: FileOutline, line: number | undefined): string {
  if (line === undefined) {
    return "unknown";
  }
  const sym = symbolAt(o, line);
  return `line ${line + 1}${sym ? `, inside ${sym.signature}` : ", at module level"}`;
}
