// What the programmer changed: diffs against two baselines per file, the text
// at the last heartbeat and the text when the graph was created. Pure.

import { structuredPatch } from "diff";

export type Baseline = "last_heartbeat" | "graph_created";

/**
 * A diff rendered with new-file line numbers, so the model can point at lines:
 *   @@ new lines 12-15 @@
 *     12 | def fetch(repo):
 *   - 13 |     return get(url)
 *   + 13 |     resp = get(url, timeout=5)
 */
export function renderDiff(oldText: string, newText: string, context = 2, maxChars = 6000): string {
  if (oldText === newText) {
    return "";
  }
  const patch = structuredPatch("before", "after", oldText, newText, undefined, undefined, { context });
  const out: string[] = [];
  for (const h of patch.hunks) {
    const last = h.newStart + Math.max(0, h.newLines - 1);
    const width = String(last).length;
    out.push(`@@ new lines ${h.newStart}-${last} @@`);
    let n = h.newStart;
    for (const l of h.lines) {
      const tag = l[0];
      const body = l.slice(1);
      if (tag === "\\") {
        continue; // "\ No newline at end of file"
      }
      if (tag === "-") {
        out.push(`- ${" ".repeat(width)} | ${body}`);
      } else {
        out.push(`${tag === "+" ? "+" : " "} ${String(n).padStart(width)} | ${body}`);
        n++;
      }
    }
  }
  const text = out.join("\n");
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…(diff truncated)" : text;
}

/** Number of changed lines (added + removed) between two texts. */
export function changedLineCount(oldText: string, newText: string): number {
  if (oldText === newText) {
    return 0;
  }
  const patch = structuredPatch("a", "b", oldText, newText, undefined, undefined, { context: 0 });
  return patch.hunks.reduce((n, h) => n + h.lines.filter((l) => l[0] === "+" || l[0] === "-").length, 0);
}

interface FileTrack {
  graphBase?: string;
  beatBase?: string;
  lastEditAt: number;
  editsSinceBeat: number;
  /** 0-based lines touched since the last heartbeat. */
  touched: Set<number>;
}

export class EditTracker {
  private readonly files = new Map<string, FileTrack>();

  constructor(private readonly now: () => number = Date.now) {}

  private track(file: string): FileTrack {
    let t = this.files.get(file);
    if (!t) {
      t = { lastEditAt: 0, editsSinceBeat: 0, touched: new Set() };
      this.files.set(file, t);
    }
    return t;
  }

  /** Remember `text` as the starting point for both baselines when absent. */
  open(file: string, text: string): void {
    const t = this.track(file);
    t.beatBase ??= text;
    t.graphBase ??= text;
  }

  edited(file: string, lines: number[]): void {
    const t = this.track(file);
    t.lastEditAt = this.now();
    t.editsSinceBeat++;
    for (const l of lines) {
      if (t.touched.size < 500) {
        t.touched.add(l);
      }
    }
  }

  /** Called after each heartbeat: the next diff starts from `text`. */
  beat(file: string, text: string): void {
    const t = this.track(file);
    t.beatBase = text;
    t.editsSinceBeat = 0;
    t.touched.clear();
  }

  /** Called when a graph is (re)drafted. */
  graphCreated(file: string, text: string): void {
    this.track(file).graphBase = text;
  }

  diff(file: string, text: string, since: Baseline, maxChars?: number): string {
    const t = this.files.get(file);
    const base = since === "graph_created" ? t?.graphBase : t?.beatBase;
    if (base === undefined) {
      return "";
    }
    return renderDiff(base, text, 2, maxChars);
  }

  /** Whether `text` differs from the last-heartbeat baseline in more than whitespace and blank lines. */
  meaningfulChange(file: string, text: string): boolean {
    const base = this.files.get(file)?.beatBase;
    if (base === undefined) {
      return true;
    }
    const norm = (t: string) =>
      t
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n");
    return norm(base) !== norm(text);
  }

  stats(file: string): { lastEditAt: number; editsSinceBeat: number; touched: number[] } {
    const t = this.files.get(file);
    return { lastEditAt: t?.lastEditAt ?? 0, editsSinceBeat: t?.editsSinceBeat ?? 0, touched: [...(t?.touched ?? [])].sort((a, b) => a - b) };
  }

  forget(file: string): void {
    this.files.delete(file);
  }

  /** The file was renamed: keep its baselines under the new name. */
  move(from: string, to: string): void {
    const t = this.files.get(from);
    if (t && from !== to) {
      this.files.set(to, t);
      this.files.delete(from);
    }
  }
}
