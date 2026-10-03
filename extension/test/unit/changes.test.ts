import * as assert from "node:assert";
import { changedLineCount, EditTracker, renderDiff } from "../../src/code/changes";

/** "line 1\nline 2\n…\nline n\n" */
function numbered(n: number, over: Record<number, string> = {}): string {
  return Array.from({ length: n }, (_, i) => over[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
}

describe("renderDiff", () => {
  it("is empty for identical texts", () => {
    assert.strictEqual(renderDiff("", ""), "");
    assert.strictEqual(renderDiff("a\nb\n", "a\nb\n"), "");
    assert.strictEqual(renderDiff(numbered(30), numbered(30)), "");
  });

  it("numbers a replaced line by its new-file position, with two lines of context", () => {
    const out = renderDiff(numbered(20), numbered(20, { 10: "LINE TEN" }));
    assert.strictEqual(
      out,
      [
        "@@ new lines 8-12 @@",
        "   8 | line 8",
        "   9 | line 9",
        "-    | line 10",
        "+ 10 | LINE TEN",
        "  11 | line 11",
        "  12 | line 12",
      ].join("\n"),
    );
  });

  it("the hunk header uses new-file line numbers, first and last", () => {
    const out = renderDiff(numbered(50), numbered(50, { 30: "changed" }));
    assert.strictEqual(out.split("\n")[0], "@@ new lines 28-32 @@");
  });

  it("right-aligns line numbers to the widest number of the hunk", () => {
    const out = renderDiff(numbered(120), numbered(120, { 99: "CHANGED" }));
    assert.strictEqual(
      out,
      [
        "@@ new lines 97-101 @@",
        "   97 | line 97",
        "   98 | line 98",
        "-     | line 99",
        "+  99 | CHANGED",
        "  100 | line 100",
        "  101 | line 101",
      ].join("\n"),
    );
  });

  it("uses a narrower gutter for hunks near the top of the file", () => {
    const out = renderDiff(numbered(5), numbered(5, { 2: "TWO" })).split("\n");
    assert.deepStrictEqual(out, ["@@ new lines 1-4 @@", "  1 | line 1", "-   | line 2", "+ 2 | TWO", "  3 | line 3", "  4 | line 4"]);
  });

  it("numbers added lines and renumbers the context after an insertion", () => {
    const out = renderDiff(numbered(8), "line 1\nline 2\nline 3\nnew a\nnew b\nline 4\nline 5\nline 6\nline 7\nline 8\n");
    assert.strictEqual(
      out,
      ["@@ new lines 2-7 @@", "  2 | line 2", "  3 | line 3", "+ 4 | new a", "+ 5 | new b", "  6 | line 4", "  7 | line 5"].join("\n"),
    );
  });

  it("shows removed lines without a number and numbers the context after them by the new file", () => {
    const out = renderDiff(numbered(10), numbered(10).replace("line 5\nline 6\n", ""));
    assert.strictEqual(
      out,
      ["@@ new lines 3-6 @@", "  3 | line 3", "  4 | line 4", "-   | line 5", "-   | line 6", "  5 | line 7", "  6 | line 8"].join("\n"),
    );
    const removed = out.split("\n").filter((l) => l.startsWith("-"));
    assert.strictEqual(removed.length, 2);
    for (const l of removed) {
      assert.ok(!/\d/.test(l.slice(0, l.indexOf("|"))), `no number on a removed line: ${l}`);
    }
  });

  it("every added line carries its new number, in sequence", () => {
    const out = renderDiff("a\nb\n", "a\nx\ny\nz\nb\n");
    assert.deepStrictEqual(out.split("\n"), ["@@ new lines 1-5 @@", "  1 | a", "+ 2 | x", "+ 3 | y", "+ 4 | z", "  5 | b"]);
  });

  it("appending at the end of the file", () => {
    const out = renderDiff(numbered(20), numbered(21));
    assert.deepStrictEqual(out.split("\n"), ["@@ new lines 19-21 @@", "  19 | line 19", "  20 | line 20", "+ 21 | line 21"]);
  });

  it("a brand new file is all additions", () => {
    assert.deepStrictEqual(renderDiff("", "x\ny\n").split("\n"), ["@@ new lines 1-2 @@", "+ 1 | x", "+ 2 | y"]);
  });

  it("emptying a file shows every old line as removed", () => {
    const out = renderDiff("x\ny\n", "").split("\n");
    assert.deepStrictEqual(out.slice(1), ["-   | x", "-   | y"]);
    assert.ok(out[0].startsWith("@@ new lines "));
  });

  it("splits distant changes into separate hunks, each with its own header and gutter width", () => {
    const out = renderDiff(numbered(20), numbered(20, { 2: "TWO", 18: "EIGHTEEN" }));
    assert.deepStrictEqual(out.split("\n"), [
      "@@ new lines 1-4 @@",
      "  1 | line 1",
      "-   | line 2",
      "+ 2 | TWO",
      "  3 | line 3",
      "  4 | line 4",
      "@@ new lines 16-20 @@",
      "  16 | line 16",
      "  17 | line 17",
      "-    | line 18",
      "+ 18 | EIGHTEEN",
      "  19 | line 19",
      "  20 | line 20",
    ]);
  });

  it("merges nearby changes into one hunk", () => {
    const out = renderDiff(numbered(10), numbered(10, { 4: "FOUR", 6: "SIX" }));
    assert.strictEqual(out.split("\n").filter((l) => l.startsWith("@@")).length, 1);
  });

  it("honors the context argument", () => {
    const next = numbered(20, { 10: "LINE TEN" });
    assert.deepStrictEqual(renderDiff(numbered(20), next, 0).split("\n"), ["@@ new lines 10-10 @@", "-    | line 10", "+ 10 | LINE TEN"]);
    const one = renderDiff(numbered(20), next, 1).split("\n");
    assert.strictEqual(one[0], "@@ new lines 9-11 @@");
    assert.strictEqual(one.length, 1 + 1 + 2 + 1);
  });

  it("keeps the indentation of code after the ' | ' separator", () => {
    const out = renderDiff("def f():\n    return 1\n", "def f():\n    x = 1\n    return x\n");
    assert.ok(out.includes("+ 2 |     x = 1"), out);
    assert.ok(out.includes("+ 3 |     return x"), out);
    assert.ok(out.includes("-   |     return 1"), out);
  });

  it("does not print the 'No newline at end of file' marker", () => {
    const out = renderDiff("a\nb", "a\nc");
    assert.ok(!out.includes("No newline"), out);
    assert.ok(!out.includes("\\"), out);
    assert.deepStrictEqual(out.split("\n"), ["@@ new lines 1-2 @@", "  1 | a", "-   | b", "+ 2 | c"]);
  });

  it("handles a change to only the final newline", () => {
    const out = renderDiff("a\nb", "a\nb\n");
    assert.ok(out.length > 0);
    assert.ok(!out.includes("No newline"), out);
  });

  describe("truncation", () => {
    const old = numbered(20);
    const next = numbered(20, { 10: "LINE TEN" });
    const full = renderDiff(old, next);

    it("cuts at maxChars and appends a marker", () => {
      const out = renderDiff(old, next, 2, 40);
      assert.strictEqual(out, full.slice(0, 40) + "\n…(diff truncated)");
      assert.ok(out.endsWith("\n…(diff truncated)"));
    });

    it("does not truncate when the diff is exactly maxChars long", () => {
      assert.strictEqual(renderDiff(old, next, 2, full.length), full);
      assert.strictEqual(renderDiff(old, next, 2, full.length + 100), full);
    });

    it("truncates when it is one character over", () => {
      const out = renderDiff(old, next, 2, full.length - 1);
      assert.strictEqual(out, full.slice(0, full.length - 1) + "\n…(diff truncated)");
    });

    it("defaults to 6000 characters", () => {
      const big = renderDiff("", Array.from({ length: 2000 }, (_, i) => `row ${i}`).join("\n") + "\n");
      assert.strictEqual(big.length, 6000 + "\n…(diff truncated)".length);
      assert.ok(big.endsWith("\n…(diff truncated)"));
      const small = renderDiff("", "just one line\n");
      assert.ok(!small.includes("truncated"));
    });

    it("an identical-text diff is empty even with a tiny limit", () => {
      assert.strictEqual(renderDiff("same", "same", 2, 1), "");
    });
  });
});

describe("changedLineCount", () => {
  it("is zero for identical texts", () => {
    assert.strictEqual(changedLineCount("", ""), 0);
    assert.strictEqual(changedLineCount(numbered(10), numbered(10)), 0);
  });

  it("counts a replaced line as one removal plus one addition", () => {
    assert.strictEqual(changedLineCount(numbered(20), numbered(20, { 10: "x" })), 2);
  });

  it("counts added lines", () => {
    assert.strictEqual(changedLineCount(numbered(5), numbered(8)), 3);
    assert.strictEqual(changedLineCount("", "a\nb\n"), 2);
  });

  it("counts removed lines", () => {
    assert.strictEqual(changedLineCount(numbered(10), numbered(10).replace("line 5\nline 6\n", "")), 2);
    assert.strictEqual(changedLineCount("a\nb\nc\n", ""), 3);
  });

  it("adds up separate changes", () => {
    assert.strictEqual(changedLineCount(numbered(40), numbered(40, { 3: "a", 20: "b", 38: "c" })), 6);
  });

  it("does not count unchanged context", () => {
    assert.strictEqual(changedLineCount(numbered(1000), numbered(1000, { 500: "changed" })), 2);
  });
});

describe("EditTracker", () => {
  let clock: number;
  let tracker: EditTracker;

  beforeEach(() => {
    clock = 1_000;
    tracker = new EditTracker(() => clock);
  });

  describe("stats", () => {
    it("are zeros for a file it has never seen", () => {
      assert.deepStrictEqual(tracker.stats("nope.py"), { lastEditAt: 0, editsSinceBeat: 0, touched: [] });
    });

    it("are still zeros after open", () => {
      tracker.open("a.py", "x\n");
      assert.deepStrictEqual(tracker.stats("a.py"), { lastEditAt: 0, editsSinceBeat: 0, touched: [] });
    });

    it("edited records the time, counts the edit and collects touched lines sorted", () => {
      tracker.open("a.py", "x\n");
      clock = 2_000;
      tracker.edited("a.py", [5, 2, 9]);
      assert.deepStrictEqual(tracker.stats("a.py"), { lastEditAt: 2_000, editsSinceBeat: 1, touched: [2, 5, 9] });
    });

    it("accumulates over several edits, de-duplicating touched lines", () => {
      tracker.open("a.py", "x\n");
      clock = 2_000;
      tracker.edited("a.py", [5, 2]);
      clock = 3_500;
      tracker.edited("a.py", [2, 1, 12]);
      clock = 3_600;
      tracker.edited("a.py", []);
      assert.deepStrictEqual(tracker.stats("a.py"), { lastEditAt: 3_600, editsSinceBeat: 3, touched: [1, 2, 5, 12] });
    });

    it("sorts numerically, not as strings", () => {
      tracker.edited("a.py", [100, 20, 3]);
      assert.deepStrictEqual(tracker.stats("a.py").touched, [3, 20, 100]);
    });

    it("tracks edits to a file that was never opened", () => {
      clock = 4_000;
      tracker.edited("late.py", [0]);
      assert.deepStrictEqual(tracker.stats("late.py"), { lastEditAt: 4_000, editsSinceBeat: 1, touched: [0] });
    });

    it("keeps files separate", () => {
      tracker.edited("a.py", [1]);
      clock = 9_000;
      tracker.edited("b.py", [7, 8]);
      assert.deepStrictEqual(tracker.stats("a.py"), { lastEditAt: 1_000, editsSinceBeat: 1, touched: [1] });
      assert.deepStrictEqual(tracker.stats("b.py"), { lastEditAt: 9_000, editsSinceBeat: 1, touched: [7, 8] });
    });

    it("remembers at most 500 touched lines", () => {
      tracker.edited(
        "big.py",
        Array.from({ length: 800 }, (_, i) => i),
      );
      const touched = tracker.stats("big.py").touched;
      assert.strictEqual(touched.length, 500);
      assert.strictEqual(touched[0], 0);
      assert.strictEqual(touched[499], 499);
      tracker.edited("big.py", [100_000]);
      assert.strictEqual(tracker.stats("big.py").touched.length, 500, "the cap holds across edits");
      assert.strictEqual(tracker.stats("big.py").editsSinceBeat, 2, "but the edit is still counted");
    });

    it("returns a copy of the touched lines", () => {
      tracker.edited("a.py", [1, 2]);
      tracker.stats("a.py").touched.push(99);
      assert.deepStrictEqual(tracker.stats("a.py").touched, [1, 2]);
    });

    it("uses Date.now by default", () => {
      const real = new EditTracker();
      const before = Date.now();
      real.edited("a.py", [1]);
      const after = Date.now();
      const t = real.stats("a.py").lastEditAt;
      assert.ok(t >= before && t <= after, `${t} not in [${before}, ${after}]`);
    });
  });

  describe("open", () => {
    it("records both baselines from the first text", () => {
      tracker.open("a.py", "v1\n");
      assert.strictEqual(tracker.diff("a.py", "v1\n", "last_heartbeat"), "");
      assert.strictEqual(tracker.diff("a.py", "v1\n", "graph_created"), "");
      assert.ok(tracker.diff("a.py", "v2\n", "last_heartbeat").includes("v2"));
      assert.ok(tracker.diff("a.py", "v2\n", "graph_created").includes("v2"));
    });

    it("sets the baselines only once: later opens do not move them", () => {
      tracker.open("a.py", "v1\n");
      tracker.open("a.py", "v2\n");
      const d = tracker.diff("a.py", "v2\n", "last_heartbeat");
      assert.deepStrictEqual(d.split("\n"), ["@@ new lines 1-1 @@", "-   | v1", "+ 1 | v2"]);
      assert.strictEqual(tracker.diff("a.py", "v2\n", "graph_created"), d);
    });

    it("does not change the stats", () => {
      tracker.edited("a.py", [3]);
      tracker.open("a.py", "x\n");
      assert.deepStrictEqual(tracker.stats("a.py"), { lastEditAt: 1_000, editsSinceBeat: 1, touched: [3] });
    });

    it("fills in a missing baseline without replacing an existing one", () => {
      tracker.graphCreated("a.py", "graph text\n");
      tracker.open("a.py", "open text\n");
      assert.deepStrictEqual(tracker.diff("a.py", "open text\n", "last_heartbeat"), "");
      assert.ok(tracker.diff("a.py", "open text\n", "graph_created").includes("graph text"));
    });

    it("an empty file is a valid baseline", () => {
      tracker.open("new.py", "");
      assert.deepStrictEqual(tracker.diff("new.py", "a\n", "last_heartbeat").split("\n"), ["@@ new lines 1-1 @@", "+ 1 | a"]);
      tracker.open("new.py", "later\n");
      assert.deepStrictEqual(tracker.diff("new.py", "a\n", "graph_created").split("\n"), ["@@ new lines 1-1 @@", "+ 1 | a"], "'' must not be treated as missing");
    });
  });

  describe("beat", () => {
    it("moves the heartbeat baseline and resets the counters, leaving the graph baseline alone", () => {
      tracker.open("a.py", "a\nb\n");
      clock = 2_000;
      tracker.edited("a.py", [1]);
      tracker.edited("a.py", [0]);
      tracker.beat("a.py", "a\nB\n");
      assert.strictEqual(tracker.diff("a.py", "a\nB\n", "last_heartbeat"), "");
      assert.notStrictEqual(tracker.diff("a.py", "a\nB\n", "graph_created"), "");
      const stats = tracker.stats("a.py");
      assert.strictEqual(stats.editsSinceBeat, 0);
      assert.deepStrictEqual(stats.touched, []);
      assert.strictEqual(stats.lastEditAt, 2_000, "the time of the last edit is kept");
    });

    it("later changes are diffed against the beat text", () => {
      tracker.open("a.py", "a\nb\n");
      tracker.beat("a.py", "a\nB\n");
      const sinceBeat = tracker.diff("a.py", "a\nB\nc\n", "last_heartbeat");
      assert.deepStrictEqual(sinceBeat.split("\n"), ["@@ new lines 1-3 @@", "  1 | a", "  2 | B", "+ 3 | c"]);
      const sinceGraph = tracker.diff("a.py", "a\nB\nc\n", "graph_created");
      assert.ok(sinceGraph.includes("-   | b"), sinceGraph);
      assert.ok(sinceGraph.includes("+ 2 | B"), sinceGraph);
      assert.ok(sinceGraph.includes("+ 3 | c"), sinceGraph);
    });

    it("counting restarts after a beat", () => {
      tracker.open("a.py", "a\n");
      tracker.edited("a.py", [0]);
      tracker.beat("a.py", "a\n");
      clock = 5_000;
      tracker.edited("a.py", [4]);
      assert.deepStrictEqual(tracker.stats("a.py"), { lastEditAt: 5_000, editsSinceBeat: 1, touched: [4] });
    });

    it("works for a file it has not seen yet", () => {
      tracker.beat("fresh.py", "text\n");
      assert.strictEqual(tracker.diff("fresh.py", "text\n", "last_heartbeat"), "");
      assert.strictEqual(tracker.diff("fresh.py", "text\n", "graph_created"), "", "no graph baseline yet");
    });
  });

  describe("graphCreated", () => {
    it("sets the graph baseline and leaves the heartbeat baseline and counters alone", () => {
      tracker.open("a.py", "v1\n");
      clock = 2_000;
      tracker.edited("a.py", [0]);
      tracker.graphCreated("a.py", "v2\n");
      assert.strictEqual(tracker.diff("a.py", "v2\n", "graph_created"), "");
      assert.notStrictEqual(tracker.diff("a.py", "v2\n", "last_heartbeat"), "");
      assert.deepStrictEqual(tracker.stats("a.py"), { lastEditAt: 2_000, editsSinceBeat: 1, touched: [0] });
    });

    it("replaces an earlier graph baseline (a re-drafted graph)", () => {
      tracker.open("a.py", "v1\n");
      tracker.graphCreated("a.py", "v2\n");
      tracker.graphCreated("a.py", "v3\n");
      assert.strictEqual(tracker.diff("a.py", "v3\n", "graph_created"), "");
      assert.ok(tracker.diff("a.py", "v4\n", "graph_created").includes("-   | v3"));
    });

    it("works before open", () => {
      tracker.graphCreated("a.py", "g\n");
      assert.strictEqual(tracker.diff("a.py", "g\n", "graph_created"), "");
      assert.strictEqual(tracker.diff("a.py", "changed\n", "last_heartbeat"), "", "no heartbeat baseline yet");
    });
  });

  describe("diff", () => {
    it("is empty for a file it does not know, for either baseline", () => {
      assert.strictEqual(tracker.diff("nope.py", "anything\n", "last_heartbeat"), "");
      assert.strictEqual(tracker.diff("nope.py", "anything\n", "graph_created"), "");
    });

    it("is empty for a known file with no baseline for that kind", () => {
      tracker.edited("a.py", [1]);
      assert.strictEqual(tracker.diff("a.py", "x\n", "last_heartbeat"), "");
      assert.strictEqual(tracker.diff("a.py", "x\n", "graph_created"), "");
    });

    it("renders with new-file line numbers and two lines of context", () => {
      tracker.open("a.py", numbered(20));
      const d = tracker.diff("a.py", numbered(20, { 10: "LINE TEN" }), "last_heartbeat");
      assert.strictEqual(d, renderDiff(numbered(20), numbered(20, { 10: "LINE TEN" })));
      assert.strictEqual(d.split("\n")[0], "@@ new lines 8-12 @@");
    });

    it("tells the two baselines apart", () => {
      tracker.open("a.py", "one\n");
      tracker.beat("a.py", "two\n");
      assert.deepStrictEqual(tracker.diff("a.py", "three\n", "last_heartbeat").split("\n"), ["@@ new lines 1-1 @@", "-   | two", "+ 1 | three"]);
      assert.deepStrictEqual(tracker.diff("a.py", "three\n", "graph_created").split("\n"), ["@@ new lines 1-1 @@", "-   | one", "+ 1 | three"]);
    });

    it("passes maxChars through", () => {
      tracker.open("a.py", numbered(20));
      const next = numbered(20, { 10: "LINE TEN" });
      const full = tracker.diff("a.py", next, "graph_created");
      const cut = tracker.diff("a.py", next, "graph_created", 30);
      assert.strictEqual(cut, full.slice(0, 30) + "\n…(diff truncated)");
    });

    it("does not change any state", () => {
      tracker.open("a.py", "a\n");
      tracker.edited("a.py", [0]);
      const before = tracker.stats("a.py");
      tracker.diff("a.py", "b\n", "last_heartbeat");
      tracker.diff("a.py", "c\n", "graph_created");
      assert.deepStrictEqual(tracker.stats("a.py"), before);
      assert.deepStrictEqual(tracker.diff("a.py", "b\n", "last_heartbeat").split("\n"), ["@@ new lines 1-1 @@", "-   | a", "+ 1 | b"]);
    });
  });

  describe("forget", () => {
    it("drops the baselines and the stats of a file", () => {
      tracker.open("a.py", "v1\n");
      tracker.graphCreated("a.py", "g\n");
      tracker.edited("a.py", [1, 2]);
      tracker.forget("a.py");
      assert.deepStrictEqual(tracker.stats("a.py"), { lastEditAt: 0, editsSinceBeat: 0, touched: [] });
      assert.strictEqual(tracker.diff("a.py", "v2\n", "last_heartbeat"), "");
      assert.strictEqual(tracker.diff("a.py", "v2\n", "graph_created"), "");
    });

    it("lets the file start afresh when opened again", () => {
      tracker.open("a.py", "old\n");
      tracker.forget("a.py");
      tracker.open("a.py", "new\n");
      assert.strictEqual(tracker.diff("a.py", "new\n", "last_heartbeat"), "");
      assert.strictEqual(tracker.diff("a.py", "new\n", "graph_created"), "");
    });

    it("leaves other files alone", () => {
      tracker.open("a.py", "a\n");
      tracker.open("b.py", "b\n");
      tracker.edited("b.py", [4]);
      tracker.forget("a.py");
      assert.deepStrictEqual(tracker.stats("b.py"), { lastEditAt: 1_000, editsSinceBeat: 1, touched: [4] });
      assert.notStrictEqual(tracker.diff("b.py", "b2\n", "last_heartbeat"), "");
    });

    it("forgetting an unknown file is a no-op", () => {
      assert.doesNotThrow(() => tracker.forget("never-seen.py"));
    });
  });

  describe("move", () => {
    it("keeps the baselines under the new name, replacing a fresh track of the new file", () => {
      tracker.open("old.py", "v1\n");
      tracker.graphCreated("old.py", "g\n");
      tracker.open("new.py", "v2\n"); // VS Code opens the renamed file first
      tracker.move("old.py", "new.py");
      assert.match(tracker.diff("new.py", "v2\n", "graph_created"), /- {3}\| g/);
      assert.match(tracker.diff("new.py", "v2\n", "last_heartbeat"), /- {3}\| v1/);
      assert.strictEqual(tracker.diff("old.py", "v2\n", "graph_created"), "");
    });

    it("does nothing for an unknown file or the same name", () => {
      tracker.open("a.py", "a\n");
      tracker.move("never-seen.py", "a.py");
      tracker.move("a.py", "a.py");
      assert.strictEqual(tracker.diff("a.py", "a\n", "graph_created"), "");
      assert.notStrictEqual(tracker.diff("a.py", "b\n", "graph_created"), "");
    });
  });

  it("a typical session: open, type, beat, type, re-draft the graph", () => {
    const v0 = "def f():\n    pass\n";
    const v1 = "def f():\n    return 1\n";
    const v2 = "def f():\n    return 1\n\ndef g():\n    pass\n";
    tracker.open("m.py", v0);
    clock = 10_000;
    tracker.edited("m.py", [1]);
    assert.deepStrictEqual(tracker.diff("m.py", v1, "last_heartbeat").split("\n"), ["@@ new lines 1-2 @@", "  1 | def f():", "-   |     pass", "+ 2 |     return 1"]);
    tracker.beat("m.py", v1);
    clock = 20_000;
    tracker.edited("m.py", [2, 3, 4]);
    assert.deepStrictEqual(tracker.stats("m.py"), { lastEditAt: 20_000, editsSinceBeat: 1, touched: [2, 3, 4] });
    assert.deepStrictEqual(tracker.diff("m.py", v2, "last_heartbeat").split("\n"), [
      "@@ new lines 1-5 @@",
      "  1 | def f():",
      "  2 |     return 1",
      "+ 3 | ",
      "+ 4 | def g():",
      "+ 5 |     pass",
    ]);
    tracker.graphCreated("m.py", v2);
    assert.strictEqual(tracker.diff("m.py", v2, "graph_created"), "");
    assert.notStrictEqual(tracker.diff("m.py", v2, "last_heartbeat"), "", "the heartbeat baseline is unaffected by a new graph");
  });
});

describe("EditTracker.meaningfulChange", () => {
  it("ignores indentation, trailing spaces and blank lines, but not real edits", () => {
    const t = new EditTracker();
    assert.strictEqual(t.meaningfulChange("a.py", "x = 1\n"), true, "no baseline yet");
    t.open("a.py", "def f():\n    return 1\n");
    assert.strictEqual(t.meaningfulChange("a.py", "def f():\n\n        return 1   \n\n"), false);
    assert.strictEqual(t.meaningfulChange("a.py", "def f():\n    return 2\n"), true);
    t.beat("a.py", "def f():\n    return 2\n");
    assert.strictEqual(t.meaningfulChange("a.py", "def f():\n    return 2\n"), false);
  });
});
