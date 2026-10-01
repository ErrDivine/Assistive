// vscode-jsonrpc wrapper: typed requests, cancellation of superseded queries.
// No `vscode` import, so it can be unit-tested over in-memory streams.

import {
  CancellationTokenSource,
  MessageConnection,
  ResponseError,
} from "vscode-jsonrpc/node";
import type {
  Card,
  ContextFrame,
  IndexProgress,
  IndexStatus,
  InitializeResult,
  MetricsReport,
  QueryResult,
  RailEvent,
} from "../types";

/** LSP's RequestCancelled; rail-server answers cancelled queries with it. */
const REQUEST_CANCELLED = -32800;

export interface InitializeParams {
  workspaceRoots: string[];
  pythonPath: string;
  config: Record<string, unknown>;
}

export interface QueryOutcome {
  result?: QueryResult;
  /** true when a newer frame superseded this one (no render should happen). */
  superseded: boolean;
  latencyMs: number;
}

export class RailClient {
  private inflight?: CancellationTokenSource;
  private latestRequestId = 0;
  private disposed = false;

  constructor(private readonly conn: MessageConnection) {}

  initialize(params: InitializeParams): Promise<InitializeResult> {
    return this.conn.sendRequest("initialize", params);
  }

  ping(): Promise<{ serverVersion: string; pid: number; python: string }> {
    return this.conn.sendRequest("ping", {});
  }

  /** Send a frame, cancelling any query still in flight. */
  async query(frame: ContextFrame): Promise<QueryOutcome> {
    this.inflight?.cancel();
    this.inflight?.dispose();
    const cts = new CancellationTokenSource();
    this.inflight = cts;
    this.latestRequestId = Math.max(this.latestRequestId, frame.requestId);
    const t0 = Date.now();
    try {
      const result = (await this.conn.sendRequest("context/query", frame, cts.token)) as QueryResult;
      const superseded = cts.token.isCancellationRequested || result.requestId !== this.latestRequestId;
      return { result: superseded ? undefined : result, superseded, latencyMs: Date.now() - t0 };
    } catch (err) {
      if (isCancellation(err) || cts.token.isCancellationRequested) {
        return { superseded: true, latencyMs: Date.now() - t0 };
      }
      throw err;
    } finally {
      if (this.inflight === cts) {
        this.inflight = undefined;
      }
      cts.dispose();
    }
  }

  cancelInflight(): void {
    this.inflight?.cancel();
  }

  status(): Promise<IndexStatus> {
    return this.conn.sendRequest("index/status", {});
  }

  sync(params: { roots?: string[]; full?: boolean } = {}): Promise<{ started: boolean }> {
    return this.conn.sendRequest("index/sync", params);
  }

  fileChanged(path: string): void {
    void this.conn.sendNotification("index/fileChanged", { path });
  }

  logEvents(events: RailEvent[]): void {
    if (events.length && !this.disposed) {
      void this.conn.sendNotification("events/log", { events });
    }
  }

  frequent(): Promise<Card[]> {
    return this.conn.sendRequest("memory/frequent", {});
  }

  pinned(): Promise<Card[]> {
    return this.conn.sendRequest("memory/pinned", {});
  }

  pin(cardId: string): Promise<object> {
    return this.conn.sendRequest("memory/pin", { cardId });
  }

  unpin(cardId: string, qualname?: string): Promise<object> {
    return this.conn.sendRequest("memory/unpin", { cardId, qualname });
  }

  metrics(sinceDays: number): Promise<MetricsReport> {
    return this.conn.sendRequest("metrics/report", { sinceDays });
  }

  readSource(params: {
    path: string;
    repo?: string;
    commit?: string;
    deleted?: boolean;
  }): Promise<{ text: string; languageId: string }> {
    return this.conn.sendRequest("source/read", params);
  }

  onProgress(handler: (p: IndexProgress) => void): void {
    this.conn.onNotification("index/progress", handler);
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    try {
      await this.conn.sendRequest("shutdown", null);
      await this.conn.sendNotification("exit", null);
    } catch {
      // the process may already be gone
    }
  }
}

function isCancellation(err: unknown): boolean {
  return (
    err instanceof ResponseError &&
    err.code === REQUEST_CANCELLED
  );
}
