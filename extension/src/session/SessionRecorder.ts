// Session record (design plan Phase 6): with `referenceRail.recordSessions` on,
// every frame and its result are appended to ~/.reference-rail/sessions/<date>.jsonl
// so `eval/run_eval.py --replay` can re-run them against a new build.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ContextFrame, QueryResult } from "../types";

export function dataDir(): string {
  return process.env.REFERENCE_RAIL_HOME || path.join(os.homedir(), ".reference-rail");
}

export class SessionRecorder {
  constructor(private readonly enabled: () => boolean) {}

  record(frame: ContextFrame, result: QueryResult | undefined, latencyMs: number, superseded: boolean): void {
    if (!this.enabled()) {
      return;
    }
    const dir = path.join(dataDir(), "sessions");
    const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      frame,
      superseded,
      latencyMs,
      cards: result?.cards.map((c) => ({ id: c.id, kind: c.kind, title: c.title, qualname: c.qualname, confidence: c.confidence })) ?? [],
    });
    fs.mkdir(dir, { recursive: true }, (err) => {
      if (!err) {
        fs.appendFile(file, line + "\n", () => undefined);
      }
    });
  }
}
