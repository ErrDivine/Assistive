// Shared types: the implementation graph, the activity feed, and the messages
// between the extension host and the panel webview. No `vscode` import here.

export const NODE_KINDS = [
  "module",
  "class",
  "function",
  "method",
  "data",
  "constant",
  "test",
  "external",
  "step",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = ["calls", "uses", "contains", "creates", "reads", "writes", "returns", "depends"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/**
 * planned  – nothing typed yet
 * stubbed  – the symbol exists but its body is a stub (pass / ... / TODO)
 * done     – the symbol exists with a real body
 * attention – the heartbeat flagged a problem in it
 */
export type NodeStatus = "planned" | "stubbed" | "done" | "attention";

export interface GraphNode {
  /** Stable slug, unique in the file's graph: `fetch_issues`, `cache_get`. */
  id: string;
  kind: NodeKind;
  /** Short display name; defaults to the symbol or id. */
  label: string;
  /** Code name the programmer will type: `fetch_issues`, `Cache.get`. */
  symbol?: string;
  /** Planned signature in the file's language. */
  signature?: string;
  /** Responsibility in one or two sentences. */
  description: string;
  /** Technical considerations: edge cases, errors, complexity, libraries. */
  notes: string[];
  /** Suggested typing order (1 = first). */
  order?: number;
  status: NodeStatus;
  /** Why the node needs attention (set by the heartbeat). */
  attention?: string;
  /** 0-based line where the symbol is defined, when it exists in the code. */
  line?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
}

export interface FileGraph {
  /** Workspace-relative path with forward slashes. */
  file: string;
  language: string;
  /** The module docstring the graph was drafted from. */
  moduleString: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  revision: number;
  updatedAt: string;
}

export interface GraphChangeSummary {
  added: string[];
  updated: string[];
  removed: string[];
  edgesAdded: number;
  edgesRemoved: number;
  /** Why nodes were removed, by id (from remove_nodes). */
  removalReasons?: Record<string, string>;
}

export type ResourceType = "docs" | "tutorial" | "article" | "video" | "book" | "reference" | "course";

export interface Resource {
  title: string;
  url: string;
  type: ResourceType;
  why: string;
  /** "ok": the link answered; "unverified": could not be checked (kept, marked). */
  verified?: "ok" | "unverified";
}

export type IssueKind =
  | "typo"
  | "syntax"
  | "logic_error"
  | "api_misuse"
  | "better_implementation"
  | "missing_edge_case"
  | "deviates_from_graph"
  | "security"
  | "other";

interface FeedBase {
  id: string;
  ts: string;
}

export type FeedItem =
  | (FeedBase & { kind: "user"; text: string })
  | (FeedBase & {
      kind: "assistant";
      text: string;
      changes?: GraphChangeSummary;
      mode: AgentMode;
      /** Tokens the turn used, when the server reports them. */
      usage?: { prompt: number; completion: number };
    })
  | (FeedBase & {
      kind: "interrupt";
      title: string;
      message: string;
      line: number; // 0-based
      endLine?: number;
      issue: IssueKind;
      severity: 1 | 2 | 3;
      status: "open" | "resolved" | "dismissed";
      lineText?: string;
      triage?: string;
    })
  | (FeedBase & { kind: "resources"; topic: string; items: Resource[] })
  | (FeedBase & { kind: "question"; question: string; options: string[]; answered?: string })
  | (FeedBase & { kind: "code_ref"; path: string; line: number; endLine?: number; note: string })
  | (FeedBase & { kind: "system"; text: string; level: "info" | "warn" | "error" });

export type AgentMode = "draft" | "chat" | "sync" | "heartbeat";

export interface ServiceStatus {
  llm: "ready" | "missing" | "error";
  jev: "ready" | "missing" | "error" | "off";
  triage: "jev" | "llm" | "off";
  heartbeat: "on" | "paused" | "off";
  heartbeatSeconds: number;
  lastBeat?: string;
  lastVerdict?: string;
  busy?: string;
  configPath?: string;
}

export interface PanelState {
  file?: string;
  language?: string;
  moduleString?: string;
  moduleStringClosed?: boolean;
  graph?: FileGraph;
  feed: FeedItem[];
  status: ServiceStatus;
  canUndo: boolean;
  supported: boolean;
  /** The active document is an untitled buffer: it must be saved before it can be planned. */
  unsaved?: boolean;
}

export type ToPanel =
  | { type: "state"; state: PanelState }
  | { type: "focusInput"; text?: string }
  | { type: "stream"; text?: string }
  | { type: "selectNode"; id: string };

export type FromPanel =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "draft" }
  | { type: "sync" }
  | { type: "undo" }
  | { type: "beatNow" }
  | { type: "toggleHeartbeat" }
  | { type: "cancel" }
  | { type: "pickFile" }
  | { type: "editNode"; id: string; op: "remove" | "toggleDone" }
  | { type: "openConfig" }
  | { type: "setup" }
  | { type: "goto"; line: number; endLine?: number; path?: string }
  | { type: "openLink"; url: string }
  | { type: "dismiss"; id: string }
  | { type: "explain"; id: string }
  | { type: "answer"; id: string; option: string }
  | { type: "copy"; text: string };

/** A feed item before the store assigns its id and timestamp. */
export type NewFeedItem = FeedItem extends infer T ? (T extends FeedItem ? Omit<T, "id" | "ts"> : never) : never;
