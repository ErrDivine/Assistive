import * as assert from "node:assert";
import { PassThrough } from "node:stream";
import {
  CancellationToken,
  createMessageConnection,
  MessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { RailClient } from "../../src/rpc/Client";
import type { QueryOutcome } from "../../src/rpc/Client";
import type { ContextFrame, IndexProgress, QueryResult, RailEvent } from "../../src/types";

const REQUEST_CANCELLED = -32800;
const QUERY_DELAY_MS = 50;

interface Received {
  method: string;
  params: unknown;
}

interface QuerySeen {
  requestId: number;
  /** true when the server was told to cancel this request before it finished. */
  cancelled: boolean;
}

interface Rig {
  client: RailClient;
  serverConn: MessageConnection;
  received: Received[];
  queries: QuerySeen[];
  dispose(): void;
}

function frame(requestId: number, over: Partial<ContextFrame> = {}): ContextFrame {
  return {
    requestId,
    trigger: "cursor_pause",
    docUri: "file:///w/a.py",
    languageId: "python",
    cursor: { line: 0, character: 0 },
    enclosingText: "",
    nearbyDefinitions: [],
    recentEdits: [],
    diagnostics: [],
    ...over,
  };
}

function event(type: string, over: Partial<RailEvent> = {}): RailEvent {
  return { ts: "2026-10-01T12:00:00.000Z", type, ...over };
}

/** Poll (yielding to the event loop) until ``cond`` holds; fail after ``timeoutMs``. */
async function until(cond: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise<void>((r) => setImmediate(r));
  }
}

const PASS_THROUGH_METHODS = [
  "initialize",
  "ping",
  "index/status",
  "index/sync",
  "memory/frequent",
  "memory/pinned",
  "memory/pin",
  "memory/unpin",
  "metrics/report",
  "source/read",
  "shutdown",
];

/**
 * A RailClient wired to an in-process fake server over two PassThrough streams.
 * The fake `context/query` handler waits ~50 ms, answering early with
 * "request cancelled" (-32800) when the client cancels, like rail-server does.
 */
function createRig(): Rig {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const clientConn = createMessageConnection(
    new StreamMessageReader(serverToClient),
    new StreamMessageWriter(clientToServer),
  );
  const serverConn = createMessageConnection(
    new StreamMessageReader(clientToServer),
    new StreamMessageWriter(serverToClient),
  );
  const received: Received[] = [];
  const queries: QuerySeen[] = [];

  serverConn.onRequest("context/query", async (f: ContextFrame, token: CancellationToken): Promise<QueryResult> => {
    const seen: QuerySeen = { requestId: f.requestId, cancelled: false };
    queries.push(seen);
    if (f.docUri === "boom") {
      throw new ResponseError(-32603, "boom");
    }
    const cancelled = await new Promise<boolean>((resolve) => {
      if (token.isCancellationRequested) {
        resolve(true);
        return;
      }
      const sub = token.onCancellationRequested(() => {
        clearTimeout(timer);
        sub.dispose();
        resolve(true);
      });
      const timer = setTimeout(() => {
        sub.dispose();
        resolve(false);
      }, QUERY_DELAY_MS);
    });
    if (cancelled) {
      seen.cancelled = true;
      throw new ResponseError(REQUEST_CANCELLED, "cancelled");
    }
    return { requestId: f.requestId, cards: [] };
  });

  for (const method of PASS_THROUGH_METHODS) {
    serverConn.onRequest(method, (params: unknown) => {
      received.push({ method, params });
      return method === "shutdown" ? null : { ok: true };
    });
  }
  for (const method of ["index/fileChanged", "events/log", "exit"]) {
    serverConn.onNotification(method, (params: unknown) => {
      received.push({ method, params });
    });
  }

  serverConn.listen();
  clientConn.listen();

  return {
    client: new RailClient(clientConn),
    serverConn,
    received,
    queries,
    dispose() {
      clientConn.dispose();
      serverConn.dispose();
      clientToServer.destroy();
      serverToClient.destroy();
    },
  };
}

describe("RailClient (against an in-process fake server)", () => {
  let rig: Rig;

  beforeEach(() => {
    rig = createRig();
  });

  afterEach(() => {
    rig.dispose();
  });

  /** Make sure every earlier notification reached the server (messages are ordered). */
  async function barrier(): Promise<void> {
    rig.client.fileChanged("__barrier__");
    await until(() => rig.received.some((r) => r.params && (r.params as { path?: string }).path === "__barrier__"), "barrier");
  }

  describe("query()", () => {
    it("returns the result of a single query", async () => {
      const outcome = await rig.client.query(frame(1));
      assert.strictEqual(outcome.superseded, false);
      assert.deepStrictEqual(outcome.result, { requestId: 1, cards: [] });
      assert.ok(Number.isFinite(outcome.latencyMs) && outcome.latencyMs >= 0);
    });

    it("sends the frame to the server unchanged", async () => {
      let seen: ContextFrame | undefined;
      rig.serverConn.onRequest("context/query", (f: ContextFrame): QueryResult => {
        seen = f;
        return { requestId: f.requestId, cards: [] };
      });
      const f = frame(3, { explicitQuestion: "what does this do?", cursor: { line: 4, character: 2 } });
      await rig.client.query(f);
      assert.deepStrictEqual(seen, f);
    });

    it("5 queries back-to-back: only the last is current, the earlier ones are superseded and do not reject", async () => {
      const pending = [1, 2, 3, 4, 5].map((id) => rig.client.query(frame(id)));
      const settled = await Promise.allSettled(pending);
      for (const [i, s] of settled.entries()) {
        assert.strictEqual(s.status, "fulfilled", `query ${i + 1} must not reject`);
      }
      const outcomes = settled.map((s) => (s as PromiseFulfilledResult<QueryOutcome>).value);
      assert.deepStrictEqual(
        outcomes.map((o) => o.superseded),
        [true, true, true, true, false],
      );
      for (const o of outcomes.slice(0, 4)) {
        assert.strictEqual(o.result, undefined, "superseded outcomes carry no result");
      }
      assert.deepStrictEqual(outcomes[4].result, { requestId: 5, cards: [] });
    });

    it("tells the server to cancel the superseded requests but not the last one", async () => {
      await Promise.all([1, 2, 3, 4, 5].map((id) => rig.client.query(frame(id))));
      const last = rig.queries.find((q) => q.requestId === 5);
      assert.ok(last, "the server saw the last query");
      assert.strictEqual(last.cancelled, false);
      for (const q of rig.queries.filter((q) => q.requestId < 5)) {
        assert.strictEqual(q.cancelled, true, `server was told to cancel request ${q.requestId}`);
      }
    });

    it("superseded queries resolve promptly instead of waiting for the full server delay", async () => {
      const t0 = Date.now();
      const outcomes = await Promise.all([1, 2, 3, 4].map((id) => rig.client.query(frame(id))));
      assert.deepStrictEqual(
        outcomes.map((o) => o.superseded),
        [true, true, true, false],
      );
      assert.ok(Date.now() - t0 < 1000);
    });

    it("a query sent while another is in flight supersedes it", async () => {
      const first = rig.client.query(frame(1));
      await new Promise((r) => setTimeout(r, 10));
      const second = await rig.client.query(frame(2));
      const firstOutcome = await first;
      assert.strictEqual(firstOutcome.superseded, true);
      assert.strictEqual(firstOutcome.result, undefined);
      assert.strictEqual(second.superseded, false);
      assert.strictEqual(second.result?.requestId, 2);
    });

    it("sequential queries (each awaited) are all current", async () => {
      for (const id of [1, 2, 3]) {
        const o = await rig.client.query(frame(id));
        assert.strictEqual(o.superseded, false, `query ${id}`);
        assert.strictEqual(o.result?.requestId, id);
      }
    });

    it("a new query works after a batch of superseded ones", async () => {
      await Promise.all([1, 2, 3].map((id) => rig.client.query(frame(id))));
      const o = await rig.client.query(frame(4));
      assert.strictEqual(o.superseded, false);
      assert.strictEqual(o.result?.requestId, 4);
    });

    it("cancelInflight() supersedes the query in flight", async () => {
      const p = rig.client.query(frame(1));
      rig.client.cancelInflight();
      const o = await p;
      assert.strictEqual(o.superseded, true);
      assert.strictEqual(o.result, undefined);
    });

    it("a cancelled query is superseded even if the server answers it successfully anyway", async () => {
      rig.serverConn.onRequest("context/query", async (f: ContextFrame): Promise<QueryResult> => {
        await new Promise((r) => setTimeout(r, 20)); // ignores the cancellation token
        return { requestId: f.requestId, cards: [] };
      });
      const p = rig.client.query(frame(1));
      rig.client.cancelInflight();
      const o = await p;
      assert.strictEqual(o.superseded, true);
      assert.strictEqual(o.result, undefined);
    });

    it("cancelInflight() with nothing in flight is harmless", async () => {
      rig.client.cancelInflight();
      const o = await rig.client.query(frame(1));
      assert.strictEqual(o.superseded, false);
      rig.client.cancelInflight();
    });

    it("a result for a requestId older than the newest frame sent is discarded", async () => {
      const first = await rig.client.query(frame(10));
      assert.strictEqual(first.superseded, false);
      const stale = await rig.client.query(frame(4));
      assert.strictEqual(stale.superseded, true);
      assert.strictEqual(stale.result, undefined);
    });

    it("rejects with the server's error when it is not a cancellation", async () => {
      await assert.rejects(rig.client.query(frame(1, { docUri: "boom" })), (err: unknown) => {
        assert.ok(err instanceof ResponseError);
        assert.strictEqual(err.code, -32603);
        assert.strictEqual(err.message, "boom");
        return true;
      });
    });

    it("a failing query that was superseded does not reject", async () => {
      const failing = rig.client.query(frame(1, { docUri: "boom" }));
      const next = rig.client.query(frame(2));
      const o1 = await failing;
      assert.strictEqual(o1.superseded, true);
      const o2 = await next;
      assert.strictEqual(o2.superseded, false);
    });

    it("a server error after a successful query still rejects the next unsuperseded query", async () => {
      const ok = await rig.client.query(frame(1));
      assert.strictEqual(ok.superseded, false);
      await assert.rejects(rig.client.query(frame(2, { docUri: "boom" })), ResponseError);
    });
  });

  describe("notifications", () => {
    it("fileChanged sends index/fileChanged with the path", async () => {
      rig.client.fileChanged("/proj/pkg/mod.py");
      await until(() => rig.received.length > 0, "index/fileChanged");
      assert.deepStrictEqual(rig.received, [{ method: "index/fileChanged", params: { path: "/proj/pkg/mod.py" } }]);
    });

    it("logEvents sends events/log with the events", async () => {
      const events = [event("card_shown", { cardId: "c1" }), event("card_opened", { cardId: "c1", payload: { via: "click" } })];
      rig.client.logEvents(events);
      await until(() => rig.received.length > 0, "events/log");
      assert.deepStrictEqual(rig.received, [{ method: "events/log", params: { events } }]);
    });

    it("logEvents([]) sends nothing", async () => {
      rig.client.logEvents([]);
      await barrier();
      assert.deepStrictEqual(
        rig.received.map((r) => r.method),
        ["index/fileChanged"],
        "only the barrier notification arrived",
      );
    });

    it("notifications arrive in the order they were sent", async () => {
      rig.client.fileChanged("/a.py");
      rig.client.logEvents([event("x")]);
      rig.client.fileChanged("/b.py");
      await until(() => rig.received.length >= 3, "three notifications");
      assert.deepStrictEqual(
        rig.received.map((r) => r.method),
        ["index/fileChanged", "events/log", "index/fileChanged"],
      );
    });

    it("onProgress delivers index/progress notifications from the server", async () => {
      const seen: IndexProgress[] = [];
      rig.client.onProgress((p) => seen.push(p));
      const progress: IndexProgress = { phase: "embed", done: 3, total: 10, message: "embedding" };
      await rig.serverConn.sendNotification("index/progress", progress);
      await until(() => seen.length > 0, "progress");
      assert.deepStrictEqual(seen, [progress]);
    });
  });

  describe("shutdown()", () => {
    it("sends the shutdown request and then the exit notification", async () => {
      await rig.client.shutdown();
      await until(() => rig.received.some((r) => r.method === "exit"), "exit");
      assert.deepStrictEqual(
        rig.received.map((r) => r.method),
        ["shutdown", "exit"],
      );
    });

    it("stops logEvents from sending anything afterwards", async () => {
      await rig.client.shutdown();
      rig.client.logEvents([event("late")]);
      await barrier();
      assert.deepStrictEqual(
        rig.received.map((r) => r.method).filter((m) => m === "events/log"),
        [],
      );
    });

    it("does not throw when the connection is already gone", async () => {
      rig.dispose();
      await assert.doesNotReject(rig.client.shutdown());
    });
  });

  describe("request wrappers", () => {
    const cases: [string, (c: RailClient) => Promise<unknown>, string, unknown][] = [
      [
        "initialize",
        (c) => c.initialize({ workspaceRoots: ["/w"], pythonPath: "python3", config: { maxCards: 3 } }),
        "initialize",
        { workspaceRoots: ["/w"], pythonPath: "python3", config: { maxCards: 3 } },
      ],
      ["ping", (c) => c.ping(), "ping", {}],
      ["status", (c) => c.status(), "index/status", {}],
      ["sync (defaults)", (c) => c.sync(), "index/sync", {}],
      ["sync (options)", (c) => c.sync({ roots: ["/r"], full: true }), "index/sync", { roots: ["/r"], full: true }],
      ["frequent", (c) => c.frequent(), "memory/frequent", {}],
      ["pinned", (c) => c.pinned(), "memory/pinned", {}],
      ["pin", (c) => c.pin("card-1"), "memory/pin", { cardId: "card-1" }],
      ["unpin", (c) => c.unpin("card-1", "pkg.fn"), "memory/unpin", { cardId: "card-1", qualname: "pkg.fn" }],
      ["metrics", (c) => c.metrics(14), "metrics/report", { sinceDays: 14 }],
      [
        "readSource",
        (c) => c.readSource({ path: "a.py", repo: "r", commit: "abc", deleted: true }),
        "source/read",
        { path: "a.py", repo: "r", commit: "abc", deleted: true },
      ],
    ];

    for (const [name, call, method, params] of cases) {
      it(`${name} sends ${method} with the documented params and returns the reply`, async () => {
        const reply = await call(rig.client);
        assert.deepStrictEqual(reply, { ok: true });
        assert.deepStrictEqual(rig.received, [{ method, params }]);
      });
    }
  });
});
