import * as assert from "node:assert";
import { reportRows, reportToCsv } from "../../src/metrics/csv";
import type { MetricsReport } from "../../src/types";

function sampleReport(over: Partial<MetricsReport> = {}): MetricsReport {
  return {
    sinceDays: 7,
    generatedAt: "2026-10-01T12:00:00Z",
    activeHours: 12.5,
    externalLookups: 40,
    lookupsPerActiveHour: 3.2,
    lookupsPerActiveHourRailOn: 2.5,
    lookupsPerActiveHourRailOff: 4.1,
    cardsShown: 100,
    cardsOpened: 30,
    cardsPinned: 5,
    cardsDismissed: 20,
    byKind: {
      precedent: { shown: 30, opened: 12, pinned: 3, dismissed: 4, openRate: 0.4 },
      api: { shown: 60, opened: 15, pinned: 1, dismissed: 10, openRate: 0.25 },
      frequent: { shown: 10, opened: 3, pinned: 1, dismissed: 6, openRate: 0.3 },
    },
    latencyP50Ms: 42,
    latencyP95Ms: 180,
    queries: 250,
    emptyRateByTrigger: { hover: 0.4, cursor_pause: 0.1, diagnostic: 0.25, explicit: 0, edit_pause: 0.05 },
    ...over,
  };
}

/** Minimal RFC 4180 reader (quoted cells, doubled quotes, newlines inside quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const snake = (s: string): string => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

const EXPECTED_SAMPLE_CSV = [
  "metric,value",
  "since_days,7",
  "generated_at,2026-10-01T12:00:00Z",
  "active_hours,12.5",
  "external_lookups,40",
  "lookups_per_active_hour,3.2",
  "lookups_per_active_hour_rail_on,2.5",
  "lookups_per_active_hour_rail_off,4.1",
  "cards_shown,100",
  "cards_opened,30",
  "cards_pinned,5",
  "cards_dismissed,20",
  "api.shown,60",
  "api.opened,15",
  "api.pinned,1",
  "api.dismissed,10",
  "api.open_rate,0.25",
  "frequent.shown,10",
  "frequent.opened,3",
  "frequent.pinned,1",
  "frequent.dismissed,6",
  "frequent.open_rate,0.3",
  "precedent.shown,30",
  "precedent.opened,12",
  "precedent.pinned,3",
  "precedent.dismissed,4",
  "precedent.open_rate,0.4",
  "latency_p50_ms,42",
  "latency_p95_ms,180",
  "queries,250",
  "empty_rate.cursor_pause,0.1",
  "empty_rate.diagnostic,0.25",
  "empty_rate.edit_pause,0.05",
  "empty_rate.explicit,0",
  "empty_rate.hover,0.4",
  "",
].join("\n");

describe("reportToCsv", () => {
  it("matches the full expected document for a sample report", () => {
    assert.strictEqual(reportToCsv(sampleReport()), EXPECTED_SAMPLE_CSV);
  });

  it("starts with the `metric,value` header line", () => {
    assert.strictEqual(reportToCsv(sampleReport()).split("\n")[0], "metric,value");
  });

  it("ends with exactly one trailing newline", () => {
    const csv = reportToCsv(sampleReport());
    assert.ok(csv.endsWith("\n"));
    assert.ok(!csv.endsWith("\n\n"));
    assert.ok(!csv.includes("\r"));
  });

  it("every row parses to exactly two cells", () => {
    const rows = parseCsv(reportToCsv(sampleReport()));
    assert.ok(rows.length > 1);
    for (const r of rows) {
      assert.strictEqual(r.length, 2, JSON.stringify(r));
    }
  });

  it("has one row per metric and no duplicate metric names", () => {
    const rows = parseCsv(reportToCsv(sampleReport())).slice(1);
    const names = rows.map((r) => r[0]);
    assert.strictEqual(new Set(names).size, names.length);
    assert.strictEqual(rows.length, reportRows(sampleReport()).length);
  });

  it("contains every MetricsReport field", () => {
    const report = sampleReport();
    const metrics = new Map(parseCsv(reportToCsv(report)).slice(1).map(([k, v]) => [k, v]));
    for (const key of Object.keys(report) as (keyof MetricsReport)[]) {
      if (key === "byKind") {
        assert.ok(Object.keys(report.byKind).length > 0);
        for (const [kind, rate] of Object.entries(report.byKind)) {
          for (const field of Object.keys(rate)) {
            assert.ok(metrics.has(`${kind}.${snake(field)}`), `missing ${kind}.${snake(field)}`);
          }
        }
      } else if (key === "emptyRateByTrigger") {
        assert.ok(Object.keys(report.emptyRateByTrigger).length > 0);
        for (const trigger of Object.keys(report.emptyRateByTrigger)) {
          assert.ok(metrics.has(`empty_rate.${trigger}`), `missing empty_rate.${trigger}`);
        }
      } else {
        assert.ok(metrics.has(snake(key)), `missing metric ${snake(key)} for field ${key}`);
        assert.strictEqual(metrics.get(snake(key)), String(report[key]), `value of ${key}`);
      }
    }
  });

  it("writes values of by-kind and empty-rate rows", () => {
    const metrics = new Map(parseCsv(reportToCsv(sampleReport())).map(([k, v]) => [k, v]));
    assert.strictEqual(metrics.get("precedent.open_rate"), "0.4");
    assert.strictEqual(metrics.get("api.shown"), "60");
    assert.strictEqual(metrics.get("empty_rate.hover"), "0.4");
  });

  describe("null and missing values", () => {
    it("renders null as an empty cell", () => {
      const lines = reportToCsv(
        sampleReport({ lookupsPerActiveHour: null, latencyP50Ms: null, latencyP95Ms: null }),
      ).split("\n");
      assert.ok(lines.includes("lookups_per_active_hour,"));
      assert.ok(lines.includes("latency_p50_ms,"));
      assert.ok(lines.includes("latency_p95_ms,"));
    });

    it("renders null rail-on/off rates as empty cells", () => {
      const lines = reportToCsv(
        sampleReport({ lookupsPerActiveHourRailOn: null, lookupsPerActiveHourRailOff: null }),
      ).split("\n");
      assert.ok(lines.includes("lookups_per_active_hour_rail_on,"));
      assert.ok(lines.includes("lookups_per_active_hour_rail_off,"));
    });

    it("keeps the row (with an empty cell) when an optional field is absent", () => {
      const report = sampleReport();
      delete report.lookupsPerActiveHourRailOn;
      delete report.lookupsPerActiveHourRailOff;
      const lines = reportToCsv(report).split("\n");
      assert.ok(lines.includes("lookups_per_active_hour_rail_on,"));
      assert.ok(lines.includes("lookups_per_active_hour_rail_off,"));
      assert.strictEqual(reportRows(report).length, reportRows(sampleReport()).length);
    });

    it("does not blank out zero values", () => {
      const lines = reportToCsv(
        sampleReport({
          cardsShown: 0,
          queries: 0,
          latencyP50Ms: 0,
          emptyRateByTrigger: { hover: 0 },
          byKind: { api: { shown: 0, opened: 0, pinned: 0, dismissed: 0, openRate: 0 } },
        }),
      ).split("\n");
      assert.ok(lines.includes("cards_shown,0"));
      assert.ok(lines.includes("queries,0"));
      assert.ok(lines.includes("latency_p50_ms,0"));
      assert.ok(lines.includes("empty_rate.hover,0"));
      assert.ok(lines.includes("api.open_rate,0"));
    });
  });

  describe("quoting", () => {
    it("quotes a value containing a comma", () => {
      const csv = reportToCsv(sampleReport({ generatedAt: "Wed, 01 Oct 2026" }));
      assert.ok(csv.split("\n").includes('generated_at,"Wed, 01 Oct 2026"'));
    });

    it("quotes a value containing a double quote and doubles it", () => {
      const csv = reportToCsv(sampleReport({ generatedAt: 'said "now"' }));
      assert.ok(csv.split("\n").includes('generated_at,"said ""now"""'));
    });

    it("quotes a value containing a newline", () => {
      const csv = reportToCsv(sampleReport({ generatedAt: "line1\nline2" }));
      assert.ok(csv.includes('generated_at,"line1\nline2"\n'));
      const parsed = new Map(parseCsv(csv).map(([k, v]) => [k, v]));
      assert.strictEqual(parsed.get("generated_at"), "line1\nline2");
    });

    it("does not quote plain values", () => {
      const csv = reportToCsv(sampleReport());
      assert.ok(!csv.includes('"'));
    });

    it("quotes metric names built from kind keys that contain commas or quotes", () => {
      const rate = { shown: 1, opened: 2, pinned: 3, dismissed: 4, openRate: 0.5 };
      const csv = reportToCsv(sampleReport({ byKind: { "a,b": rate, 'he said "hi"': rate } }));
      const lines = csv.split("\n");
      assert.ok(lines.includes('"a,b.shown",1'), "comma in a kind");
      assert.ok(lines.includes('"he said ""hi"".shown",1'), "quote in a kind");
      const names = new Set(parseCsv(csv).map((r) => r[0]));
      assert.ok(names.has("a,b.open_rate"));
      assert.ok(names.has('he said "hi".dismissed'));
    });

    it("quotes metric names built from trigger keys that contain commas", () => {
      const csv = reportToCsv(sampleReport({ emptyRateByTrigger: { "x,y": 0.5 } }));
      assert.ok(csv.split("\n").includes('"empty_rate.x,y",0.5'));
    });

    it("round-trips awkward values through a CSV reader", () => {
      const awkward = 'a,"b"\nc,,';
      const csv = reportToCsv(sampleReport({ generatedAt: awkward, byKind: {}, emptyRateByTrigger: { [awkward]: 1 } }));
      const parsed = new Map(parseCsv(csv).map(([k, v]) => [k, v]));
      assert.strictEqual(parsed.get("generated_at"), awkward);
      assert.strictEqual(parsed.get(`empty_rate.${awkward}`), "1");
    });

    // Possible BUG (low severity): src/metrics/csv.ts `cell()` only quotes cells
    // matching /[",\n]/, so a value or key containing a bare carriage return is
    // emitted unquoted. RFC 4180 readers (and Python's csv module) treat a bare
    // CR as a record break, which would split the row.
    //   input   : generatedAt = "a\rb"
    //   expected: `generated_at,"a\rb"`
    //   actual  : `generated_at,a\rb`
    it("quotes a value containing a carriage return", () => {
      const csv = reportToCsv(sampleReport({ generatedAt: "a\rb" }));
      assert.ok(csv.includes('generated_at,"a\rb"'));
    });
  });

  describe("ordering", () => {
    it("sorts byKind keys alphabetically and emits five rows per kind", () => {
      const names = parseCsv(reportToCsv(sampleReport())).map((r) => r[0]);
      const kindRows = names.filter((n) => /^(api|frequent|precedent)\./.test(n));
      assert.deepStrictEqual(kindRows, [
        ...["shown", "opened", "pinned", "dismissed", "open_rate"].map((f) => `api.${f}`),
        ...["shown", "opened", "pinned", "dismissed", "open_rate"].map((f) => `frequent.${f}`),
        ...["shown", "opened", "pinned", "dismissed", "open_rate"].map((f) => `precedent.${f}`),
      ]);
    });

    it("sorts emptyRateByTrigger keys alphabetically", () => {
      const names = parseCsv(reportToCsv(sampleReport())).map((r) => r[0]);
      assert.deepStrictEqual(
        names.filter((n) => n.startsWith("empty_rate.")),
        ["empty_rate.cursor_pause", "empty_rate.diagnostic", "empty_rate.edit_pause", "empty_rate.explicit", "empty_rate.hover"],
      );
    });

    it("output does not depend on the insertion order of the maps", () => {
      const a = sampleReport();
      const b = sampleReport({
        byKind: Object.fromEntries(Object.entries(a.byKind).reverse()),
        emptyRateByTrigger: Object.fromEntries(Object.entries(a.emptyRateByTrigger).reverse()),
      });
      assert.strictEqual(reportToCsv(a), reportToCsv(b));
    });

    it("places scalar rows, then by-kind rows, then latency/queries, then empty-rate rows", () => {
      const names = parseCsv(reportToCsv(sampleReport())).map((r) => r[0]);
      const idx = (n: string): number => names.indexOf(n);
      assert.ok(idx("cards_dismissed") < idx("api.shown"));
      assert.ok(idx("precedent.open_rate") < idx("latency_p50_ms"));
      assert.ok(idx("latency_p50_ms") < idx("latency_p95_ms"));
      assert.ok(idx("latency_p95_ms") < idx("queries"));
      assert.ok(idx("queries") < idx("empty_rate.cursor_pause"));
      assert.strictEqual(names[names.length - 1], "empty_rate.hover");
    });

    it("does not mutate the report", () => {
      const report = sampleReport();
      const before = JSON.stringify(report);
      reportToCsv(report);
      reportRows(report);
      assert.strictEqual(JSON.stringify(report), before);
    });
  });

  describe("empty maps", () => {
    it("emits only the scalar rows when byKind and emptyRateByTrigger are empty", () => {
      const csv = reportToCsv(sampleReport({ byKind: {}, emptyRateByTrigger: {} }));
      const names = parseCsv(csv).map((r) => r[0]);
      assert.deepStrictEqual(names, [
        "metric",
        "since_days",
        "generated_at",
        "active_hours",
        "external_lookups",
        "lookups_per_active_hour",
        "lookups_per_active_hour_rail_on",
        "lookups_per_active_hour_rail_off",
        "cards_shown",
        "cards_opened",
        "cards_pinned",
        "cards_dismissed",
        "latency_p50_ms",
        "latency_p95_ms",
        "queries",
      ]);
    });
  });
});

describe("reportRows", () => {
  it("returns [metric, value] tuples with raw values", () => {
    const rows = reportRows(sampleReport());
    assert.deepStrictEqual(rows[0], ["since_days", 7]);
    assert.deepStrictEqual(rows[1], ["generated_at", "2026-10-01T12:00:00Z"]);
    assert.deepStrictEqual(rows[2], ["active_hours", 12.5]);
    assert.deepStrictEqual(rows[rows.length - 1], ["empty_rate.hover", 0.4]);
  });

  it("maps missing and null values to null", () => {
    const report = sampleReport({ lookupsPerActiveHour: null, latencyP95Ms: null });
    delete report.lookupsPerActiveHourRailOn;
    const rows = new Map(reportRows(report));
    assert.strictEqual(rows.get("lookups_per_active_hour"), null);
    assert.strictEqual(rows.get("lookups_per_active_hour_rail_on"), null);
    assert.strictEqual(rows.get("lookups_per_active_hour_rail_off"), 4.1);
    assert.strictEqual(rows.get("latency_p95_ms"), null);
  });

  it("has 11 leading scalar rows, 5 rows per kind, 3 trailing scalar rows and one row per trigger", () => {
    const report = sampleReport();
    const expected =
      11 + 5 * Object.keys(report.byKind).length + 3 + Object.keys(report.emptyRateByTrigger).length;
    assert.strictEqual(reportRows(report).length, expected);
  });

  it("emits kind rows in the order shown, opened, pinned, dismissed, open_rate", () => {
    const rows = reportRows(sampleReport({ byKind: { api: { shown: 1, opened: 2, pinned: 3, dismissed: 4, openRate: 0.5 } } }));
    assert.deepStrictEqual(
      rows.filter(([k]) => k.startsWith("api.")),
      [
        ["api.shown", 1],
        ["api.opened", 2],
        ["api.pinned", 3],
        ["api.dismissed", 4],
        ["api.open_rate", 0.5],
      ],
    );
  });
});
