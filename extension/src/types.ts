// Wire schemas (design plan §7.2). Mirrored exactly in server/rail_server/models.py.
// Kept free of `vscode` imports so the webview and unit tests can use it.

export type Trigger = "cursor_pause" | "edit_pause" | "diagnostic" | "hover" | "explicit";

/** 0-based line and character, as VS Code reports them. */
export interface SourceLoc {
  path: string;
  line: number;
  character: number;
}

export interface ContextFrame {
  requestId: number; // strictly increasing per session
  trigger: Trigger;
  docUri: string;
  languageId: string;
  cursor: { line: number; character: number };
  enclosingText: string; // enclosing def/class, else ±40 lines; ≤ 4 KB
  enclosingRange?: { startLine: number; endLine: number }; // 0-based, inclusive
  symbolAtCursor?: { text: string; definition?: SourceLoc; hoverText?: string };
  nearbyDefinitions: SourceLoc[]; // ≤ 5
  recentEdits: { line: number; text: string; ts: number }[]; // ≤ 10
  diagnostics: { message: string; line: number; source?: string }[]; // within ±5 lines
  explicitQuestion?: string;
}

/** A real file span: 1-based inclusive lines (invariant I2). */
export interface SourceRef {
  path: string;
  startLine: number;
  endLine: number;
  distName?: string;
  distVersion?: string;
  repo?: string;
  commit?: string;
  deleted?: boolean;
  runtime?: { pythonVersion: string }; // origin = runtime_doc
}

export type FactLabel = "signature" | "summary" | "returns" | "raises" | "param" | "note";
export type FactOrigin = "signature" | "docstring" | "source_scan" | "runtime_doc";

export interface Fact {
  label: FactLabel;
  text: string;
  origin: FactOrigin;
  span: SourceRef; // I2
}

export type CardKind = "api" | "precedent" | "frequent";

export interface Card {
  id: string; // stable: hash(kind, chunk_id)
  kind: CardKind;
  title: string;
  facts: Fact[];
  snippet?: { text: string; startLine: number };
  source: SourceRef;
  confidence: number; // 0..1
  reason: string;
  // Extensions (DECISIONS.md D-012)
  qualname?: string;
  stale?: boolean;
  pinned?: boolean;
  authoredAt?: string;
}

export interface QueryResult {
  requestId: number;
  cards: Card[];
}

export interface RailEvent {
  ts: string;
  type: string;
  cardId?: string;
  qualname?: string;
  trigger?: string;
  payload?: Record<string, unknown>;
}

export interface IndexProgress {
  phase: string;
  done: number;
  total: number;
  message: string;
}

export interface IndexStatus {
  dists: number;
  chunks: number;
  codeChunks: number;
  embedded: number;
  lastSync: string | null;
  syncing: boolean;
  embedder: string | null;
  vectors: number;
  pythonVersion?: string;
  pythonPath?: string;
  dataDir?: string;
}

export interface OpenRate {
  shown: number;
  opened: number;
  pinned: number;
  dismissed: number;
  openRate: number;
}

export interface MetricsReport {
  sinceDays: number;
  generatedAt: string;
  activeHours: number;
  externalLookups: number;
  lookupsPerActiveHour: number | null;
  lookupsPerActiveHourRailOn?: number | null;
  lookupsPerActiveHourRailOff?: number | null;
  cardsShown: number;
  cardsOpened: number;
  cardsPinned: number;
  cardsDismissed: number;
  byKind: Record<string, OpenRate>;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  queries: number;
  emptyRateByTrigger: Record<string, number>;
}

export interface InitializeResult {
  serverVersion: string;
  capabilities: Record<string, boolean>;
  dataDir?: string;
}
