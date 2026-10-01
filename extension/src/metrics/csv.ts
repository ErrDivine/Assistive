// MetricsReport → CSV (one "metric,value" row per field). Pure; unit-tested.

import type { MetricsReport } from "../types";

function cell(v: unknown): string {
  if (v === null || v === undefined) {
    return "";
  }
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Flatten a report to ordered [metric, value] rows. */
export function reportRows(r: MetricsReport): [string, string | number | null][] {
  const rows: [string, string | number | null][] = [
    ["since_days", r.sinceDays],
    ["generated_at", r.generatedAt],
    ["active_hours", r.activeHours],
    ["external_lookups", r.externalLookups],
    ["lookups_per_active_hour", r.lookupsPerActiveHour],
    ["lookups_per_active_hour_rail_on", r.lookupsPerActiveHourRailOn ?? null],
    ["lookups_per_active_hour_rail_off", r.lookupsPerActiveHourRailOff ?? null],
    ["cards_shown", r.cardsShown],
    ["cards_opened", r.cardsOpened],
    ["cards_pinned", r.cardsPinned],
    ["cards_dismissed", r.cardsDismissed],
  ];
  for (const kind of Object.keys(r.byKind).sort()) {
    const k = r.byKind[kind];
    rows.push(
      [`${kind}.shown`, k.shown],
      [`${kind}.opened`, k.opened],
      [`${kind}.pinned`, k.pinned],
      [`${kind}.dismissed`, k.dismissed],
      [`${kind}.open_rate`, k.openRate],
    );
  }
  rows.push(
    ["latency_p50_ms", r.latencyP50Ms],
    ["latency_p95_ms", r.latencyP95Ms],
    ["queries", r.queries],
  );
  for (const trigger of Object.keys(r.emptyRateByTrigger).sort()) {
    rows.push([`empty_rate.${trigger}`, r.emptyRateByTrigger[trigger]]);
  }
  return rows;
}

export function reportToCsv(r: MetricsReport): string {
  return ["metric,value", ...reportRows(r).map(([k, v]) => `${cell(k)},${cell(v)}`)].join("\n") + "\n";
}
