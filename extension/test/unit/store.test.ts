import * as assert from "node:assert";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphStore, MAX_FEED, MAX_HISTORY } from "../../src/store/GraphStore";
import type { FeedItem, FileGraph, GraphNode, NewFeedItem } from "../../src/types";
import { FakeClock } from "./fakeClock";

const OLD_STAMP = "2000-01-01T00:00:00.000Z";

function node(id: string): GraphNode {
  return { id, kind: "function", label: id, description: `does ${id}`, notes: [], status: "planned" };
}

function graphOf(file: string, revision: number, nodeIds: string[] = []): FileGraph {
  return { file, language: "python", moduleString: "Doc.", nodes: nodeIds.map(node), edges: [], revision, updatedAt: OLD_STAMP };
}

const userItem = (text: string): NewFeedItem => ({ kind: "user", text });

function interruptItem(line = 3): NewFeedItem {
  return { kind: "interrupt", title: "Problem", message: "Look here.", line, issue: "logic_error", severity: 2, status: "open", lineText: "x = 1" };
}

// ---------------------------------------------------------------- temp dirs and stores

const tempDirs: string[] = [];
const stores: GraphStore[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistive-store-"));
  tempDirs.push(dir);
  return dir;
}

/** A store that is flushed (so no timer can write after cleanup) when the test ends. */
function track(store: GraphStore): GraphStore {
  stores.push(store);
  return store;
}

function memoryStore(): GraphStore {
  return track(new GraphStore(undefined));
}

function diskStore(dir: string, delayMs = 0): GraphStore {
  return track(new GraphStore(dir, delayMs));
}

afterEach(() => {
  while (stores.length) {
    stores.pop()!.flush();
  }
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** Where the store keeps a file's record. */
function recordPath(dir: string, file: string): string {
  return path.join(dir, "graphs", `${createHash("sha1").update(file).digest("hex").slice(0, 16)}.json`);
}

function readRecord(dir: string, file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(recordPath(dir, file), "utf8")) as Record<string, unknown>;
}

/**
 * Runs `fn` with the global timers replaced by a manual clock, so the store's debounced save is
 * deterministic. The timers are restored when `fn` returns (it must be synchronous).
 */
function withFakeTimers(fn: (clock: FakeClock) => void): void {
  const clock = new FakeClock();
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  globalThis.setTimeout = ((f: () => void, ms?: number) => clock.setTimeout(f, ms ?? 0)) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((h: unknown) => clock.clearTimeout(h)) as unknown as typeof clearTimeout;
  try {
    fn(clock);
  } finally {
    globalThis.setTimeout = real.setTimeout;
    globalThis.clearTimeout = real.clearTimeout;
  }
}

// ---------------------------------------------------------------- in memory

describe("GraphStore (in memory)", () => {
  describe("records", () => {
    it("an unknown file has an empty record", () => {
      const s = memoryStore();
      assert.deepStrictEqual(s.get("a.py"), { file: "a.py", feed: [], history: [] });
      assert.strictEqual(s.graph("a.py"), undefined);
      assert.strictEqual(s.canUndo("a.py"), false);
    });

    it("get returns the same live record each time", () => {
      const s = memoryStore();
      assert.strictEqual(s.get("a.py"), s.get("a.py"));
      assert.notStrictEqual(s.get("a.py"), s.get("b.py"));
    });

    it("files() lists the files touched so far", () => {
      const s = memoryStore();
      assert.deepStrictEqual(s.files(), []);
      s.get("a.py");
      s.graph("b.py");
      assert.deepStrictEqual(s.files(), ["a.py", "b.py"]);
    });

    it("keeps files independent", () => {
      const s = memoryStore();
      s.setGraph("a.py", graphOf("a.py", 1), false);
      s.addFeed("b.py", userItem("hi"));
      assert.strictEqual(s.graph("b.py"), undefined);
      assert.strictEqual(s.get("a.py").feed.length, 0);
    });

    it("flush is a harmless no-op without a directory", () => {
      const s = memoryStore();
      s.setGraph("a.py", graphOf("a.py", 1), false);
      assert.doesNotThrow(() => s.flush());
    });
  });

  describe("setGraph", () => {
    it("sets the graph without touching the undo stack when snapshot is false", () => {
      const s = memoryStore();
      const g = graphOf("a.py", 1, ["x"]);
      s.setGraph("a.py", g, false);
      assert.strictEqual(s.graph("a.py"), g);
      assert.strictEqual(s.canUndo("a.py"), false);
      assert.deepStrictEqual(s.get("a.py").history, []);
    });

    it("pushes the snapshot onto the undo stack", () => {
      const s = memoryStore();
      const g1 = graphOf("a.py", 1);
      const g2 = graphOf("a.py", 2);
      s.setGraph("a.py", g1, false);
      s.setGraph("a.py", g2, g1);
      assert.strictEqual(s.graph("a.py"), g2);
      assert.strictEqual(s.canUndo("a.py"), true);
      assert.deepStrictEqual(s.get("a.py").history, [g1]);
    });

    it("stores a copy of the snapshot, so later edits to the original do not leak into history", () => {
      const s = memoryStore();
      const g1 = graphOf("a.py", 1, ["x"]);
      s.setGraph("a.py", graphOf("a.py", 2), g1);
      g1.nodes.push(node("added-later"));
      g1.revision = 99;
      assert.strictEqual(s.get("a.py").history[0].revision, 1);
      assert.deepStrictEqual(
        s.get("a.py").history[0].nodes.map((n) => n.id),
        ["x"],
      );
    });

    it("an undefined snapshot (there was no previous graph) adds nothing to history", () => {
      const s = memoryStore();
      s.setGraph("a.py", graphOf("a.py", 1), undefined);
      assert.strictEqual(s.canUndo("a.py"), false);
    });

    it("can remove the graph", () => {
      const s = memoryStore();
      s.setGraph("a.py", graphOf("a.py", 1), false);
      s.setGraph("a.py", undefined, false);
      assert.strictEqual(s.graph("a.py"), undefined);
    });

    it("keeps at most MAX_HISTORY snapshots, dropping the oldest", () => {
      const s = memoryStore();
      const total = MAX_HISTORY + 7;
      for (let i = 1; i <= total; i++) {
        s.setGraph("a.py", graphOf("a.py", i + 1), graphOf("a.py", i));
      }
      const history = s.get("a.py").history;
      assert.strictEqual(history.length, MAX_HISTORY);
      assert.strictEqual(history[0].revision, total - MAX_HISTORY + 1, "oldest kept");
      assert.strictEqual(history[history.length - 1].revision, total, "newest kept");
    });

    it("undo walks back through exactly MAX_HISTORY revisions after overflow", () => {
      const s = memoryStore();
      const total = MAX_HISTORY + 5;
      for (let i = 1; i <= total; i++) {
        s.setGraph("a.py", graphOf("a.py", i + 1), graphOf("a.py", i));
      }
      const seen: number[] = [];
      for (let g = s.undo("a.py"); g; g = s.undo("a.py")) {
        seen.push(g.revision);
      }
      assert.strictEqual(seen.length, MAX_HISTORY);
      assert.strictEqual(seen[0], total);
      assert.strictEqual(seen[seen.length - 1], total - MAX_HISTORY + 1);
    });

    it("exactly MAX_HISTORY snapshots are all kept", () => {
      const s = memoryStore();
      for (let i = 1; i <= MAX_HISTORY; i++) {
        s.setGraph("a.py", graphOf("a.py", i + 1), graphOf("a.py", i));
      }
      assert.strictEqual(s.get("a.py").history.length, MAX_HISTORY);
      assert.strictEqual(s.get("a.py").history[0].revision, 1);
    });
  });

  describe("undo", () => {
    it("restores the previous revision and returns it", () => {
      const s = memoryStore();
      const g1 = graphOf("a.py", 1, ["one"]);
      s.setGraph("a.py", g1, false);
      s.setGraph("a.py", graphOf("a.py", 2, ["one", "two"]), g1);
      const restored = s.undo("a.py");
      assert.ok(restored);
      assert.strictEqual(restored.revision, 1);
      assert.deepStrictEqual(
        restored.nodes.map((n) => n.id),
        ["one"],
      );
      assert.strictEqual(s.graph("a.py"), restored);
      assert.strictEqual(s.canUndo("a.py"), false);
    });

    it("refreshes updatedAt on the restored graph", () => {
      const s = memoryStore();
      s.setGraph("a.py", graphOf("a.py", 2), graphOf("a.py", 1));
      const restored = s.undo("a.py")!;
      assert.notStrictEqual(restored.updatedAt, OLD_STAMP);
      assert.ok(!Number.isNaN(Date.parse(restored.updatedAt)));
    });

    it("returns undefined when there is nothing to undo, and changes nothing", () => {
      const s = memoryStore();
      assert.strictEqual(s.undo("a.py"), undefined);
      const g = graphOf("a.py", 4);
      s.setGraph("a.py", g, false);
      assert.strictEqual(s.undo("a.py"), undefined);
      assert.strictEqual(s.graph("a.py"), g);
    });

    it("steps back through several revisions in order, then runs out", () => {
      const s = memoryStore();
      const g1 = graphOf("a.py", 1);
      const g2 = graphOf("a.py", 2);
      const g3 = graphOf("a.py", 3);
      s.setGraph("a.py", g1, false);
      s.setGraph("a.py", g2, g1);
      s.setGraph("a.py", g3, g2);
      assert.strictEqual(s.undo("a.py")?.revision, 2);
      assert.strictEqual(s.undo("a.py")?.revision, 1);
      assert.strictEqual(s.undo("a.py"), undefined);
      assert.strictEqual(s.graph("a.py")?.revision, 1);
    });

    it("can undo into a graph restored from before a clear", () => {
      const s = memoryStore();
      s.setGraph("a.py", graphOf("a.py", 5, ["keep"]), false);
      s.clear("a.py");
      assert.strictEqual(s.graph("a.py"), undefined);
      const back = s.undo("a.py");
      assert.strictEqual(back?.revision, 5);
      assert.deepStrictEqual(
        back?.nodes.map((n) => n.id),
        ["keep"],
      );
    });
  });

  describe("clear", () => {
    it("removes the graph and puts it on the undo stack", () => {
      const s = memoryStore();
      const g = graphOf("a.py", 3);
      s.setGraph("a.py", g, false);
      s.clear("a.py");
      assert.strictEqual(s.graph("a.py"), undefined);
      assert.strictEqual(s.canUndo("a.py"), true);
      assert.deepStrictEqual(s.get("a.py").history[0], g);
    });

    it("clearing a file with no graph adds no history", () => {
      const s = memoryStore();
      s.clear("a.py");
      assert.strictEqual(s.canUndo("a.py"), false);
      assert.deepStrictEqual(s.get("a.py").history, []);
    });

    it("keeps the feed", () => {
      const s = memoryStore();
      s.setGraph("a.py", graphOf("a.py", 1), false);
      s.addFeed("a.py", userItem("hello"));
      s.clear("a.py");
      assert.strictEqual(s.get("a.py").feed.length, 1);
    });

    it("clearing twice does not stack the same graph twice", () => {
      const s = memoryStore();
      s.setGraph("a.py", graphOf("a.py", 1), false);
      s.clear("a.py");
      s.clear("a.py");
      assert.strictEqual(s.get("a.py").history.length, 1);
    });

    it("the undo stack stays within MAX_HISTORY when clearing", () => {
      const s = memoryStore();
      for (let i = 0; i < MAX_HISTORY + 5; i++) {
        s.setGraph("a.py", graphOf("a.py", i), false);
        s.clear("a.py");
      }
      assert.ok(s.get("a.py").history.length <= MAX_HISTORY, `history has ${s.get("a.py").history.length} entries`);
    });
  });

  describe("feed", () => {
    it("addFeed assigns an id and a timestamp and keeps the item's own fields", () => {
      const s = memoryStore();
      const before = Date.now();
      const item = s.addFeed("a.py", userItem("hello"));
      const after = Date.now();
      assert.strictEqual(item.kind, "user");
      assert.strictEqual((item as Extract<FeedItem, { kind: "user" }>).text, "hello");
      assert.match(item.id, /^[0-9a-f]{8}$/);
      const t = Date.parse(item.ts);
      assert.ok(t >= before && t <= after, `${item.ts} outside the call window`);
      assert.strictEqual(new Date(t).toISOString(), item.ts, "ISO format");
    });

    it("returns the stored object and appends in order", () => {
      const s = memoryStore();
      const a = s.addFeed("a.py", userItem("one"));
      const b = s.addFeed("a.py", userItem("two"));
      assert.deepStrictEqual(s.get("a.py").feed, [a, b]);
      assert.strictEqual(s.get("a.py").feed[0], a);
    });

    it("gives every item its own id", () => {
      const s = memoryStore();
      const ids = new Set(Array.from({ length: 100 }, (_, i) => s.addFeed("a.py", userItem(String(i))).id));
      assert.strictEqual(ids.size, 100);
    });

    it("ignores an id or timestamp supplied by the caller", () => {
      const s = memoryStore();
      const item = s.addFeed("a.py", { ...userItem("x"), id: "forced", ts: "forced" } as unknown as NewFeedItem);
      assert.notStrictEqual(item.id, "forced");
      assert.notStrictEqual(item.ts, "forced");
    });

    it("keeps at most MAX_FEED items, dropping the oldest", () => {
      const s = memoryStore();
      const first = s.addFeed("a.py", userItem("m0"));
      for (let i = 1; i < MAX_FEED + 5; i++) {
        s.addFeed("a.py", userItem(`m${i}`));
      }
      const feed = s.get("a.py").feed;
      assert.strictEqual(feed.length, MAX_FEED);
      assert.strictEqual((feed[0] as { text: string }).text, "m5");
      assert.strictEqual((feed[feed.length - 1] as { text: string }).text, `m${MAX_FEED + 4}`);
      assert.strictEqual(s.findFeed(first.id), undefined, "a dropped item can no longer be found");
    });

    it("exactly MAX_FEED items are all kept", () => {
      const s = memoryStore();
      for (let i = 0; i < MAX_FEED; i++) s.addFeed("a.py", userItem(`m${i}`));
      assert.strictEqual(s.get("a.py").feed.length, MAX_FEED);
      assert.strictEqual((s.get("a.py").feed[0] as { text: string }).text, "m0");
    });

    it("the cap is per file", () => {
      const s = memoryStore();
      for (let i = 0; i < MAX_FEED + 10; i++) s.addFeed("a.py", userItem(`m${i}`));
      s.addFeed("b.py", userItem("only"));
      assert.strictEqual(s.get("b.py").feed.length, 1);
    });

    it("findFeed locates an item in any file", () => {
      const s = memoryStore();
      const a = s.addFeed("a.py", userItem("one"));
      const b = s.addFeed("b.py", userItem("two"));
      assert.deepStrictEqual(s.findFeed(a.id), { file: "a.py", item: a });
      assert.deepStrictEqual(s.findFeed(b.id), { file: "b.py", item: b });
      assert.strictEqual(s.findFeed(a.id)?.item, a, "the live object, not a copy");
    });

    it("findFeed returns undefined for an unknown id", () => {
      const s = memoryStore();
      s.addFeed("a.py", userItem("one"));
      assert.strictEqual(s.findFeed("nope"), undefined);
      assert.strictEqual(memoryStore().findFeed("nope"), undefined);
    });

    it("updateFeed merges a patch into the item", () => {
      const s = memoryStore();
      const item = s.addFeed("a.py", interruptItem());
      s.updateFeed("a.py", item.id, { status: "resolved", line: 7 } as Partial<FeedItem>);
      const stored = s.get("a.py").feed[0] as Extract<FeedItem, { kind: "interrupt" }>;
      assert.strictEqual(stored.status, "resolved");
      assert.strictEqual(stored.line, 7);
      assert.strictEqual(stored.title, "Problem", "other fields stay");
      assert.strictEqual(stored.id, item.id);
    });

    it("updateFeed on an unknown id does nothing", () => {
      const s = memoryStore();
      s.addFeed("a.py", userItem("one"));
      const before = JSON.stringify(s.get("a.py").feed);
      let fired = 0;
      s.onChange(() => fired++);
      s.updateFeed("a.py", "nope", { text: "changed" } as Partial<FeedItem>);
      assert.strictEqual(JSON.stringify(s.get("a.py").feed), before);
      assert.strictEqual(fired, 0, "no change event for a no-op");
    });

    it("updateFeed only looks in the given file", () => {
      const s = memoryStore();
      const a = s.addFeed("a.py", userItem("one"));
      s.addFeed("b.py", userItem("two"));
      s.updateFeed("b.py", a.id, { text: "hijacked" } as Partial<FeedItem>);
      assert.strictEqual((s.get("a.py").feed[0] as { text: string }).text, "one");
    });
  });

  describe("change listeners", () => {
    it("fire with the file name on every kind of change", () => {
      const s = memoryStore();
      const seen: string[] = [];
      s.onChange((f) => seen.push(f));
      s.setGraph("a.py", graphOf("a.py", 1), false);
      const item = s.addFeed("b.py", userItem("x"));
      s.updateFeed("b.py", item.id, { text: "y" } as Partial<FeedItem>);
      s.setGraph("a.py", graphOf("a.py", 2), graphOf("a.py", 1));
      s.undo("a.py");
      s.clear("a.py");
      s.changed("c.py");
      assert.deepStrictEqual(seen, ["a.py", "b.py", "b.py", "a.py", "a.py", "a.py", "c.py"]);
    });

    it("do not fire for a failed undo or a read", () => {
      const s = memoryStore();
      let fired = 0;
      s.onChange(() => fired++);
      s.undo("a.py");
      s.get("a.py");
      s.graph("a.py");
      s.canUndo("a.py");
      s.findFeed("x");
      assert.strictEqual(fired, 0);
    });

    it("call every listener, in registration order", () => {
      const s = memoryStore();
      const order: string[] = [];
      s.onChange(() => order.push("first"));
      s.onChange(() => order.push("second"));
      s.onChange(() => order.push("third"));
      s.addFeed("a.py", userItem("x"));
      assert.deepStrictEqual(order, ["first", "second", "third"]);
    });

    it("stop after dispose()", () => {
      const s = memoryStore();
      let a = 0;
      let b = 0;
      const subA = s.onChange(() => a++);
      s.onChange(() => b++);
      s.addFeed("a.py", userItem("1"));
      subA.dispose();
      s.addFeed("a.py", userItem("2"));
      subA.dispose(); // idempotent
      assert.strictEqual(a, 1);
      assert.strictEqual(b, 2);
    });

    it("a throwing listener does not stop the others or break the operation", () => {
      const s = memoryStore();
      const seen: string[] = [];
      s.onChange(() => {
        throw new Error("listener bug");
      });
      s.onChange((f) => seen.push(f));
      const g = graphOf("a.py", 1);
      assert.doesNotThrow(() => s.setGraph("a.py", g, false));
      assert.deepStrictEqual(seen, ["a.py"]);
      assert.strictEqual(s.graph("a.py"), g, "the change itself went through");
      assert.doesNotThrow(() => s.addFeed("a.py", userItem("x")));
      assert.deepStrictEqual(seen, ["a.py", "a.py"]);
    });

    it("fire synchronously, after the state has changed", () => {
      const s = memoryStore();
      let revisionSeen: number | undefined;
      s.onChange((f) => {
        revisionSeen = s.graph(f)?.revision;
      });
      s.setGraph("a.py", graphOf("a.py", 8), false);
      assert.strictEqual(revisionSeen, 8);
    });

    it("a listener can dispose itself while being called", () => {
      const s = memoryStore();
      let calls = 0;
      const sub = s.onChange(() => {
        calls++;
        sub.dispose();
      });
      let other = 0;
      s.onChange(() => other++);
      s.addFeed("a.py", userItem("1"));
      s.addFeed("a.py", userItem("2"));
      assert.strictEqual(calls, 1);
      assert.strictEqual(other, 2);
    });
  });
});

// ---------------------------------------------------------------- on disk

describe("GraphStore (persisted)", () => {
  it("writes nothing until the save delay has passed or flush() is called", () => {
    const dir = tempDir();
    const s = diskStore(dir, 60_000);
    s.setGraph("a.py", graphOf("a.py", 1), false);
    assert.strictEqual(fs.existsSync(recordPath(dir, "a.py")), false);
    s.flush();
    assert.strictEqual(fs.existsSync(recordPath(dir, "a.py")), true);
  });

  it("writes <dir>/graphs/<sha1(file)[0:16]>.json containing the whole record", () => {
    const dir = tempDir();
    const s = diskStore(dir);
    const g1 = graphOf("src/a.py", 1, ["x"]);
    const g2 = graphOf("src/a.py", 2, ["x", "y"]);
    s.setGraph("src/a.py", g1, false);
    s.setGraph("src/a.py", g2, g1);
    const item = s.addFeed("src/a.py", userItem("hi"));
    s.flush();
    const rec = readRecord(dir, "src/a.py");
    assert.strictEqual(rec.file, "src/a.py");
    assert.deepStrictEqual(rec.graph, g2);
    assert.deepStrictEqual(rec.history, [g1]);
    assert.deepStrictEqual(rec.feed, [item]);
  });

  it("coalesces several changes into one write holding the latest state", () => {
    const dir = tempDir();
    const s = diskStore(dir, 60_000);
    for (let i = 1; i <= 5; i++) {
      s.setGraph("a.py", graphOf("a.py", i), false);
    }
    s.flush();
    assert.strictEqual((readRecord(dir, "a.py").graph as FileGraph).revision, 5);
  });

  it("saves automatically once the save delay has passed (400 ms by default)", () => {
    withFakeTimers((clock) => {
      const dir = tempDir();
      const s = track(new GraphStore(dir));
      s.setGraph("a.py", graphOf("a.py", 1), false);
      clock.advance(399);
      assert.strictEqual(fs.existsSync(recordPath(dir, "a.py")), false, "not yet");
      clock.advance(1);
      assert.strictEqual(fs.existsSync(recordPath(dir, "a.py")), true);
      assert.strictEqual((readRecord(dir, "a.py").graph as FileGraph).revision, 1);
      assert.strictEqual(clock.pendingTimers, 0);
    });
  });

  it("a delay of 0 saves on the next tick", () => {
    withFakeTimers((clock) => {
      const dir = tempDir();
      const s = diskStore(dir, 0);
      s.setGraph("a.py", graphOf("a.py", 1), false);
      assert.strictEqual(fs.existsSync(recordPath(dir, "a.py")), false, "saving is never synchronous");
      clock.advance(0);
      assert.strictEqual(fs.existsSync(recordPath(dir, "a.py")), true);
    });
  });

  it("each change restarts the delay and only one save is pending per file", () => {
    withFakeTimers((clock) => {
      const dir = tempDir();
      const s = diskStore(dir, 100);
      s.setGraph("a.py", graphOf("a.py", 1), false);
      clock.advance(60);
      s.setGraph("a.py", graphOf("a.py", 2), false);
      s.addFeed("a.py", userItem("x"));
      assert.strictEqual(clock.pendingTimers, 1);
      clock.advance(99);
      assert.strictEqual(fs.existsSync(recordPath(dir, "a.py")), false, "still waiting for the last change");
      clock.advance(1);
      const rec = readRecord(dir, "a.py");
      assert.strictEqual((rec.graph as FileGraph).revision, 2);
      assert.strictEqual((rec.feed as unknown[]).length, 1);
    });
  });

  it("keeps a separate pending save for each file", () => {
    withFakeTimers((clock) => {
      const dir = tempDir();
      const s = diskStore(dir, 100);
      s.setGraph("a.py", graphOf("a.py", 1), false);
      clock.advance(50);
      s.setGraph("b.py", graphOf("b.py", 1), false);
      assert.strictEqual(clock.pendingTimers, 2);
      clock.advance(50);
      assert.strictEqual(fs.existsSync(recordPath(dir, "a.py")), true);
      assert.strictEqual(fs.existsSync(recordPath(dir, "b.py")), false);
      clock.advance(50);
      assert.strictEqual(fs.existsSync(recordPath(dir, "b.py")), true);
    });
  });

  it("flush() cancels the pending timers, so nothing is rewritten later", () => {
    withFakeTimers((clock) => {
      const dir = tempDir();
      const s = diskStore(dir, 100);
      s.setGraph("a.py", graphOf("a.py", 1), false);
      s.setGraph("b.py", graphOf("b.py", 1), false);
      assert.strictEqual(clock.pendingTimers, 2);
      s.flush();
      assert.strictEqual(clock.pendingTimers, 0);
      fs.rmSync(recordPath(dir, "a.py"));
      clock.advance(10_000);
      assert.strictEqual(fs.existsSync(recordPath(dir, "a.py")), false);
    });
  });

  it("an in-memory store never schedules a save", () => {
    withFakeTimers((clock) => {
      const s = memoryStore();
      s.setGraph("a.py", graphOf("a.py", 1), false);
      s.addFeed("a.py", userItem("x"));
      assert.strictEqual(clock.pendingTimers, 0);
    });
  });

  it("flush() saves every file with pending changes", () => {
    const dir = tempDir();
    const s = diskStore(dir, 60_000);
    s.setGraph("a.py", graphOf("a.py", 1), false);
    s.setGraph("b/c.py", graphOf("b/c.py", 2), false);
    s.flush();
    assert.strictEqual((readRecord(dir, "a.py").graph as FileGraph).revision, 1);
    assert.strictEqual((readRecord(dir, "b/c.py").graph as FileGraph).revision, 2);
    assert.strictEqual(fs.readdirSync(path.join(dir, "graphs")).length, 2);
  });

  it("flush() leaves no temporary files behind and is repeatable", () => {
    const dir = tempDir();
    const s = diskStore(dir, 60_000);
    s.setGraph("a.py", graphOf("a.py", 1), false);
    s.flush();
    s.flush();
    const names = fs.readdirSync(path.join(dir, "graphs"));
    assert.strictEqual(names.length, 1);
    assert.ok(names[0].endsWith(".json"));
    assert.ok(!names.some((n) => n.endsWith(".tmp")));
  });

  it("creates the storage folder on demand", () => {
    const dir = path.join(tempDir(), "does", "not", "exist", "yet");
    const s = diskStore(dir);
    s.setGraph("a.py", graphOf("a.py", 1), false);
    s.flush();
    assert.strictEqual(fs.existsSync(recordPath(dir, "a.py")), true);
  });

  it("different files get different record files", () => {
    const dir = tempDir();
    assert.notStrictEqual(recordPath(dir, "a.py"), recordPath(dir, "b.py"));
    assert.notStrictEqual(recordPath(dir, "a/b.py"), recordPath(dir, "a_b.py"));
  });

  describe("round trip", () => {
    it("a new store on the same folder reads what the first one saved", () => {
      const dir = tempDir();
      const s1 = diskStore(dir);
      const g1 = graphOf("a.py", 1, ["x"]);
      const g2 = graphOf("a.py", 2, ["x", "y"]);
      s1.setGraph("a.py", g1, false);
      s1.setGraph("a.py", g2, g1);
      const user = s1.addFeed("a.py", userItem("hello"));
      const irq = s1.addFeed("a.py", interruptItem(9));
      s1.flush();

      const s2 = diskStore(dir);
      assert.deepStrictEqual(s2.graph("a.py"), g2);
      assert.deepStrictEqual(s2.get("a.py").feed, [user, irq]);
      assert.deepStrictEqual(s2.get("a.py").history, [g1]);
      assert.strictEqual(s2.canUndo("a.py"), true);
      assert.strictEqual(s2.findFeed(irq.id)?.file, "a.py");
    });

    it("undo works across a restart", () => {
      const dir = tempDir();
      const s1 = diskStore(dir);
      const g1 = graphOf("a.py", 1, ["x"]);
      s1.setGraph("a.py", g1, false);
      s1.setGraph("a.py", graphOf("a.py", 2), g1);
      s1.flush();
      const s2 = diskStore(dir);
      assert.strictEqual(s2.undo("a.py")?.revision, 1);
      s2.flush();
      assert.strictEqual(diskStore(dir).graph("a.py")?.revision, 1, "the undo itself is persisted");
    });

    it("a cleared graph can still be undone after a restart", () => {
      const dir = tempDir();
      const s1 = diskStore(dir);
      s1.setGraph("a.py", graphOf("a.py", 4, ["x"]), false);
      s1.clear("a.py");
      s1.flush();
      const s2 = diskStore(dir);
      assert.strictEqual(s2.graph("a.py"), undefined);
      assert.strictEqual(s2.undo("a.py")?.revision, 4);
    });

    it("updateFeed changes are persisted", () => {
      const dir = tempDir();
      const s1 = diskStore(dir);
      const item = s1.addFeed("a.py", interruptItem());
      s1.updateFeed("a.py", item.id, { status: "dismissed" } as Partial<FeedItem>);
      s1.flush();
      const loaded = diskStore(dir).get("a.py").feed[0] as Extract<FeedItem, { kind: "interrupt" }>;
      assert.strictEqual(loaded.status, "dismissed");
    });

    it("the feed cap holds in what is saved", () => {
      const dir = tempDir();
      const s1 = diskStore(dir);
      for (let i = 0; i < MAX_FEED + 3; i++) s1.addFeed("a.py", userItem(`m${i}`));
      s1.flush();
      assert.strictEqual((readRecord(dir, "a.py").feed as unknown[]).length, MAX_FEED);
    });

    it("keeps files separate on disk", () => {
      const dir = tempDir();
      const s1 = diskStore(dir);
      s1.setGraph("a.py", graphOf("a.py", 1), false);
      s1.setGraph("b.py", graphOf("b.py", 2), false);
      s1.flush();
      const s2 = diskStore(dir);
      assert.strictEqual(s2.graph("a.py")?.revision, 1);
      assert.strictEqual(s2.graph("b.py")?.revision, 2);
      assert.strictEqual(s2.graph("c.py"), undefined);
    });

    it("a record is loaded lazily and then cached in memory", () => {
      const dir = tempDir();
      const s1 = diskStore(dir);
      s1.setGraph("a.py", graphOf("a.py", 1), false);
      s1.flush();
      const s2 = diskStore(dir);
      assert.deepStrictEqual(s2.files(), []);
      assert.strictEqual(s2.graph("a.py")?.revision, 1);
      assert.deepStrictEqual(s2.files(), ["a.py"]);
      fs.writeFileSync(recordPath(dir, "a.py"), JSON.stringify({ file: "a.py", graph: graphOf("a.py", 99), feed: [], history: [] }));
      assert.strictEqual(s2.graph("a.py")?.revision, 1, "the loaded record is not re-read");
    });

    it("a store without a directory never reads or writes files", () => {
      const dir = tempDir();
      const writer = diskStore(dir);
      writer.setGraph("a.py", graphOf("a.py", 1), false);
      writer.flush();
      const mem = memoryStore();
      assert.strictEqual(mem.graph("a.py"), undefined);
      mem.setGraph("a.py", graphOf("a.py", 7), false);
      mem.flush();
      assert.strictEqual(diskStore(dir).graph("a.py")?.revision, 1);
    });
  });

  describe("unreadable records", () => {
    function seed(dir: string, file: string, text: string): void {
      fs.mkdirSync(path.join(dir, "graphs"), { recursive: true });
      fs.writeFileSync(recordPath(dir, file), text);
    }

    it("a corrupt JSON file is ignored and the file starts empty", () => {
      const dir = tempDir();
      seed(dir, "a.py", "{ this is not json");
      const s = diskStore(dir);
      assert.deepStrictEqual(s.get("a.py"), { file: "a.py", feed: [], history: [] });
      assert.strictEqual(s.graph("a.py"), undefined);
      assert.strictEqual(s.canUndo("a.py"), false);
    });

    it("an empty or truncated file is ignored", () => {
      const dir = tempDir();
      seed(dir, "a.py", "");
      seed(dir, "b.py", '{"file":"b.py","graph":{"file":"b.py","nod');
      const s = diskStore(dir);
      assert.strictEqual(s.graph("a.py"), undefined);
      assert.strictEqual(s.graph("b.py"), undefined);
    });

    it("JSON that is not a record object is ignored", () => {
      const dir = tempDir();
      seed(dir, "null.py", "null");
      seed(dir, "array.py", "[1,2,3]");
      seed(dir, "number.py", "42");
      seed(dir, "string.py", '"text"');
      const s = diskStore(dir);
      for (const f of ["null.py", "array.py", "number.py", "string.py"]) {
        assert.deepStrictEqual(s.get(f), { file: f, feed: [], history: [] }, f);
      }
    });

    it("a record that belongs to a different file is ignored", () => {
      const dir = tempDir();
      seed(dir, "a.py", JSON.stringify({ file: "other.py", graph: graphOf("other.py", 3), feed: [], history: [] }));
      const s = diskStore(dir);
      assert.strictEqual(s.graph("a.py"), undefined);
      assert.strictEqual(s.get("a.py").file, "a.py");
    });

    it("a record without a file field is ignored", () => {
      const dir = tempDir();
      seed(dir, "a.py", JSON.stringify({ graph: graphOf("a.py", 3) }));
      assert.strictEqual(diskStore(dir).graph("a.py"), undefined);
    });

    it("a record missing feed and history gets empty ones", () => {
      const dir = tempDir();
      seed(dir, "a.py", JSON.stringify({ file: "a.py", graph: graphOf("a.py", 3) }));
      const s = diskStore(dir);
      assert.strictEqual(s.graph("a.py")?.revision, 3);
      assert.deepStrictEqual(s.get("a.py").feed, []);
      assert.deepStrictEqual(s.get("a.py").history, []);
      assert.strictEqual(s.canUndo("a.py"), false);
    });

    it("saving after a corrupt load overwrites it with a valid record", () => {
      const dir = tempDir();
      seed(dir, "a.py", "garbage");
      const s1 = diskStore(dir);
      s1.setGraph("a.py", graphOf("a.py", 2), false);
      s1.flush();
      assert.strictEqual(diskStore(dir).graph("a.py")?.revision, 2);
    });

    it("one corrupt record does not affect other files", () => {
      const dir = tempDir();
      const s1 = diskStore(dir);
      s1.setGraph("good.py", graphOf("good.py", 5), false);
      s1.flush();
      seed(dir, "bad.py", "{{{");
      const s2 = diskStore(dir);
      assert.strictEqual(s2.graph("bad.py"), undefined);
      assert.strictEqual(s2.graph("good.py")?.revision, 5);
    });
  });

  describe("storage failures", () => {
    it("a save that cannot be written is swallowed", () => {
      const parent = tempDir();
      const blocker = path.join(parent, "blocker");
      fs.writeFileSync(blocker, "I am a file, not a folder");
      const s = diskStore(blocker, 60_000);
      s.setGraph("a.py", graphOf("a.py", 1), false);
      assert.doesNotThrow(() => s.flush());
      assert.strictEqual(s.graph("a.py")?.revision, 1, "the in-memory state is unaffected");
    });

    it("reading from a folder that does not exist just gives an empty record", () => {
      const s = diskStore(path.join(tempDir(), "missing"));
      assert.deepStrictEqual(s.get("a.py"), { file: "a.py", feed: [], history: [] });
    });
  });
});

describe("GraphStore.clearFeed", () => {
  it("clears the conversation but keeps open interrupts", () => {
    const store = new GraphStore(undefined);
    store.addFeed("/a.py", { kind: "user", text: "hi" });
    store.addFeed("/a.py", { kind: "assistant", text: "hello", mode: "chat" });
    const open = store.addFeed("/a.py", {
      kind: "interrupt",
      title: "Typo",
      message: "m",
      line: 1,
      issue: "typo",
      severity: 3,
      status: "open",
      lineText: "x",
    });
    store.addFeed("/a.py", { kind: "interrupt", title: "Old", message: "m", line: 2, issue: "typo", severity: 1, status: "dismissed" });
    let fired = 0;
    store.onChange(() => fired++);
    store.clearFeed("/a.py");
    assert.deepStrictEqual(store.get("/a.py").feed.map((f) => f.id), [open.id]);
    assert.strictEqual(fired, 1);
  });
});

describe("GraphStore.plannedFiles", () => {
  const g = (file: string, n: number): FileGraph => ({
    file,
    language: "python",
    moduleString: "Doc.",
    nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, kind: "function" as const, label: `n${i}`, description: "d", notes: [], status: "planned" as const })),
    edges: [],
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  it("lists saved graphs from disk and loaded ones from memory, without empty or cleared graphs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistive-planned-"));
    try {
      const a = new GraphStore(dir, 0);
      a.setGraph("/p/a.py", g("a.py", 2), false);
      a.setGraph("/p/b.py", g("b.py", 1), false);
      a.setGraph("/p/empty.py", g("empty.py", 0), false);
      a.flush();
      const b = new GraphStore(dir, 0);
      assert.deepStrictEqual(b.plannedFiles().map((p) => p.file).sort(), ["/p/a.py", "/p/b.py"]);
      b.clear("/p/b.py"); // cleared in memory before the save
      b.setGraph("/p/c.py", g("c.py", 1), false);
      assert.deepStrictEqual(b.plannedFiles().map((p) => p.file).sort(), ["/p/a.py", "/p/c.py"]);
      fs.writeFileSync(path.join(dir, "graphs", "broken.json"), "{not json");
      assert.strictEqual(b.plannedFiles().length, 2, "a damaged file is skipped");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("works without a storage folder", () => {
    const s = new GraphStore(undefined);
    s.setGraph("/p/a.py", g("a.py", 1), false);
    assert.deepStrictEqual(s.plannedFiles().map((p) => p.file), ["/p/a.py"]);
  });
});

describe("GraphStore.move and moveTree", () => {
  const g = (file: string, ids: string[] = ["a"]): FileGraph => ({ ...graphOf(file, 1, ids) });

  it("moves the graph, the feed and the history, and gives them the new relative path", () => {
    const dir = tempDir();
    const s = track(new GraphStore(dir, 0));
    s.setGraph("/w/old.py", g("old.py", ["a"]), false);
    s.setGraph("/w/old.py", g("old.py", ["a", "b"]), s.graph("/w/old.py"));
    s.addFeed("/w/old.py", userItem("hello"));
    s.flush();
    const fired: string[] = [];
    s.onChange((f) => fired.push(f));
    assert.strictEqual(s.move("/w/old.py", "/w/pkg/new.py", "pkg/new.py"), true);
    assert.strictEqual(s.graph("/w/pkg/new.py")?.file, "pkg/new.py");
    assert.deepStrictEqual(s.graph("/w/pkg/new.py")?.nodes.map((n) => n.id), ["a", "b"]);
    assert.strictEqual(s.get("/w/pkg/new.py").history[0].file, "pkg/new.py");
    assert.strictEqual(s.get("/w/pkg/new.py").feed[0].kind, "user");
    assert.strictEqual(s.graph("/w/old.py"), undefined);
    assert.deepStrictEqual(s.get("/w/old.py").feed, []);
    assert.deepStrictEqual(fired, ["/w/old.py", "/w/pkg/new.py"]);
    s.flush();
    const reloaded = new GraphStore(dir, 0);
    assert.strictEqual(reloaded.graph("/w/old.py"), undefined, "the old record is gone from disk");
    assert.strictEqual(reloaded.graph("/w/pkg/new.py")?.file, "pkg/new.py");
    assert.deepStrictEqual(reloaded.plannedFiles().map((p) => p.file), ["/w/pkg/new.py"]);
  });

  it("moves a record that is only on disk", () => {
    const dir = tempDir();
    const a = track(new GraphStore(dir, 0));
    a.setGraph("/w/old.py", g("old.py"), false);
    a.flush();
    const b = track(new GraphStore(dir, 0));
    assert.strictEqual(b.move("/w/old.py", "/w/new.py", "new.py"), true);
    assert.strictEqual(b.graph("/w/new.py")?.file, "new.py");
  });

  it("does not move an empty record, and never overwrites another plan", () => {
    const s = track(new GraphStore(undefined));
    assert.strictEqual(s.move("/w/none.py", "/w/x.py", "x.py"), false);
    s.setGraph("/w/a.py", g("a.py", ["a"]), false);
    s.setGraph("/w/b.py", g("b.py", ["b"]), false);
    assert.strictEqual(s.move("/w/a.py", "/w/b.py", "b.py"), false);
    assert.deepStrictEqual(s.graph("/w/b.py")?.nodes.map((n) => n.id), ["b"]);
    assert.strictEqual(s.graph("/w/a.py")?.file, "a.py");
    assert.strictEqual(s.move("/w/a.py", "/w/a.py", "a.py"), false);
  });

  it("moveTree moves a file, or every file under a folder, and nothing beside it", () => {
    const dir = tempDir();
    const s = track(new GraphStore(dir, 0));
    const sep = path.sep;
    const p = (...parts: string[]) => [sep + "w", ...parts].join(sep);
    s.setGraph(p("src", "a.py"), g("src/a.py"), false);
    s.setGraph(p("src", "sub", "b.py"), g("src/sub/b.py"), false);
    s.setGraph(p("srcx", "c.py"), g("srcx/c.py"), false);
    s.flush();
    const moves = s.moveTree(p("src"), p("lib"), (f) => f.slice(p().length + 1).split(sep).join("/"));
    assert.deepStrictEqual(moves.map((m) => m.to).sort(), [p("lib", "a.py"), p("lib", "sub", "b.py")]);
    assert.strictEqual(s.graph(p("lib", "sub", "b.py"))?.file, "lib/sub/b.py");
    assert.strictEqual(s.graph(p("srcx", "c.py"))?.file, "srcx/c.py", "a sibling with the same prefix stays");
    assert.deepStrictEqual(s.moveTree(p("lib", "a.py"), p("lib", "z.py"), () => "lib/z.py"), [{ from: p("lib", "a.py"), to: p("lib", "z.py") }]);
  });
});

describe("GraphStore.findOrphan", () => {
  const plan = (file: string, doc: string, language = "python"): FileGraph => ({ ...graphOf(file, 1, ["a"]), moduleString: doc, language });

  it("finds the one plan with the same language and docstring whose file is gone", () => {
    const s = track(new GraphStore(undefined));
    s.setGraph("/w/gone.py", plan("gone.py", "Fetch issues.\n"), false);
    s.setGraph("/w/here.py", plan("here.py", "Other doc."), false);
    s.setGraph("/w/gone.ts", plan("gone.ts", "Fetch issues.", "typescript"), false);
    const exists = (f: string) => f === "/w/here.py";
    assert.strictEqual(s.findOrphan("  Fetch issues.  ", "python", exists)?.file, "/w/gone.py");
    assert.strictEqual(s.findOrphan("Fetch issues.", "typescript", exists)?.file, "/w/gone.ts");
    assert.strictEqual(s.findOrphan("Other doc.", "python", exists), undefined, "its file still exists");
    assert.strictEqual(s.findOrphan("Fetch issues.", "go", exists), undefined, "another language");
    assert.strictEqual(s.findOrphan("", "python", exists), undefined);
  });

  it("finds nothing when two orphans match, or when the plan has no nodes", () => {
    const s = track(new GraphStore(undefined));
    s.setGraph("/w/a.py", plan("a.py", "Same doc."), false);
    s.setGraph("/w/b.py", plan("b.py", "Same doc."), false);
    assert.strictEqual(s.findOrphan("Same doc.", "python", () => false), undefined, "ambiguous");
    s.setGraph("/w/c.py", { ...plan("c.py", "Empty plan."), nodes: [] }, false);
    assert.strictEqual(s.findOrphan("Empty plan.", "python", () => false), undefined);
  });
});
