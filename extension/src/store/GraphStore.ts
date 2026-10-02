// Per-file graph, feed and undo history, persisted as JSON under the
// extension's workspace storage: <storage>/graphs/<sha1(relpath)>.json.

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FeedItem, FileGraph, NewFeedItem } from "../types";

export const MAX_FEED = 200;
export const MAX_HISTORY = 20;

export interface FileRecord {
  file: string;
  graph?: FileGraph;
  feed: FeedItem[];
  /** Earlier graph revisions, most recent last. */
  history: FileGraph[];
}

export class GraphStore {
  private readonly records = new Map<string, FileRecord>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly listeners = new Set<(file: string) => void>();

  constructor(
    private readonly dir: string | undefined,
    private readonly saveDelayMs = 400,
  ) {}

  onChange(fn: (file: string) => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private fire(file: string): void {
    for (const fn of this.listeners) {
      try {
        fn(file);
      } catch {
        // a listener's failure must not break the store
      }
    }
  }

  private pathFor(file: string): string | undefined {
    if (!this.dir) {
      return undefined;
    }
    const hash = createHash("sha1").update(file).digest("hex").slice(0, 16);
    return path.join(this.dir, "graphs", `${hash}.json`);
  }

  get(file: string): FileRecord {
    let rec = this.records.get(file);
    if (rec) {
      return rec;
    }
    rec = { file, feed: [], history: [] };
    const p = this.pathFor(file);
    if (p) {
      try {
        const data = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<FileRecord>;
        if (data.file === file) {
          rec = { file, graph: data.graph, feed: data.feed ?? [], history: data.history ?? [] };
        }
      } catch {
        // no saved state yet
      }
    }
    this.records.set(file, rec);
    return rec;
  }

  graph(file: string): FileGraph | undefined {
    return this.get(file).graph;
  }

  /** Replace the graph. With `snapshot`, the previous graph goes on the undo stack. */
  setGraph(file: string, graph: FileGraph | undefined, snapshot: FileGraph | undefined | false): void {
    const rec = this.get(file);
    if (snapshot) {
      rec.history.push(structuredClone(snapshot));
      if (rec.history.length > MAX_HISTORY) {
        rec.history.splice(0, rec.history.length - MAX_HISTORY);
      }
    }
    rec.graph = graph;
    this.changed(file);
  }

  canUndo(file: string): boolean {
    return this.get(file).history.length > 0;
  }

  /** Restore the previous revision; returns it, or undefined when there is none. */
  undo(file: string): FileGraph | undefined {
    const rec = this.get(file);
    const prev = rec.history.pop();
    if (!prev) {
      return undefined;
    }
    rec.graph = { ...prev, updatedAt: new Date().toISOString() };
    this.changed(file);
    return rec.graph;
  }

  addFeed(file: string, item: NewFeedItem): FeedItem {
    const rec = this.get(file);
    const full = { ...item, id: randomUUID().slice(0, 8), ts: new Date().toISOString() } as FeedItem;
    rec.feed.push(full);
    if (rec.feed.length > MAX_FEED) {
      rec.feed.splice(0, rec.feed.length - MAX_FEED);
    }
    this.changed(file);
    return full;
  }

  findFeed(id: string): { file: string; item: FeedItem } | undefined {
    for (const rec of this.records.values()) {
      const item = rec.feed.find((f) => f.id === id);
      if (item) {
        return { file: rec.file, item };
      }
    }
    return undefined;
  }

  updateFeed(file: string, id: string, patch: Partial<FeedItem>): void {
    const item = this.get(file).feed.find((f) => f.id === id);
    if (item) {
      Object.assign(item, patch);
      this.changed(file);
    }
  }

  clear(file: string): void {
    const rec = this.get(file);
    if (rec.graph) {
      this.setGraph(file, undefined, rec.graph);
    }
  }

  /** Files with a record loaded in memory. */
  files(): string[] {
    return [...this.records.keys()];
  }

  changed(file: string): void {
    this.fire(file);
    this.scheduleSave(file);
  }

  private scheduleSave(file: string): void {
    if (!this.dir) {
      return;
    }
    clearTimeout(this.pending.get(file));
    this.pending.set(
      file,
      setTimeout(() => this.save(file), this.saveDelayMs),
    );
  }

  private save(file: string): void {
    this.pending.delete(file);
    const p = this.pathFor(file);
    const rec = this.records.get(file);
    if (!p || !rec) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rec));
      fs.renameSync(tmp, p);
    } catch {
      // storage is best effort
    }
  }

  flush(): void {
    for (const [file, t] of [...this.pending]) {
      clearTimeout(t);
      this.save(file);
    }
  }
}
