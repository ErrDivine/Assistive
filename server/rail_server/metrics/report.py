"""MetricsReport (design plan §9.8).

* External lookup: a ``focus_lost`` → ``focus_gained`` pair lasting 3 s–10 min,
  with no debug session active at the blur and an edit in the 2 minutes before it.
* Active editing hour: an hour bucket with at least 6 ``edit_tick`` events.
* North star: external lookups per active editing hour.
"""

from __future__ import annotations

import json
import math
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

from ..models import MetricsReport, OpenRate

MIN_BLUR_S = 3.0
MAX_BLUR_S = 600.0
EDIT_BEFORE_BLUR_S = 120.0
ACTIVE_HOUR_TICKS = 6
CARD_KINDS = ("api", "precedent", "frequent")


def parse_ts(ts: str) -> datetime:
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def percentile(values: list[float], p: float) -> float | None:
    """Nearest-rank percentile."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(p / 100.0 * len(ordered)))
    return round(ordered[rank - 1], 2)


def _payload(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        val = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return val if isinstance(val, dict) else {}


def _hour(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H")


def build_report(
    conn: sqlite3.Connection, since_days: int, now: datetime | None = None
) -> MetricsReport:
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=max(0, since_days))
    rows = conn.execute(
        "SELECT ts, type, card_id, qualname, trigger, payload FROM events "
        "WHERE ts >= ? ORDER BY ts, id",
        (since.isoformat(timespec="milliseconds"),),
    ).fetchall()
    events = [
        {
            "ts": parse_ts(r[0]),
            "type": r[1],
            "card_id": r[2],
            "qualname": r[3],
            "trigger": r[4],
            "payload": _payload(r[5]),
        }
        for r in rows
    ]

    # Active hours (and whether the rail was on during them).
    ticks: dict[str, list[bool]] = {}
    tick_times: list[datetime] = []
    for e in events:
        if e["type"] == "edit_tick":
            ticks.setdefault(_hour(e["ts"]), []).append(bool(e["payload"].get("railEnabled", True)))
            tick_times.append(e["ts"])
    active = {h: states for h, states in ticks.items() if len(states) >= ACTIVE_HOUR_TICKS}
    active_on = sum(1 for s in active.values() if sum(s) * 2 >= len(s))
    active_off = len(active) - active_on

    # External lookups from blur pairs.
    lookups = lookups_on = lookups_off = 0
    pending: dict[str, Any] | None = None
    for e in events:
        if e["type"] == "focus_lost":
            pending = e
        elif e["type"] == "focus_gained" and pending is not None:
            dur = (e["ts"] - pending["ts"]).total_seconds()
            p = pending["payload"]
            pending = None
            if not (MIN_BLUR_S <= dur <= MAX_BLUR_S) or p.get("debug"):
                continue
            since_edit = p.get("msSinceLastEdit")
            if since_edit is not None:
                edited = 0 <= float(since_edit) <= EDIT_BEFORE_BLUR_S * 1000
            else:
                blur = e["ts"] - timedelta(seconds=dur)
                edited = any(
                    0 <= (blur - t).total_seconds() <= EDIT_BEFORE_BLUR_S for t in tick_times
                )
            if not edited:
                continue
            lookups += 1
            if p.get("railEnabled", True):
                lookups_on += 1
            else:
                lookups_off += 1

    # Cards.
    counts = {t: 0 for t in ("card_shown", "card_opened", "card_pinned", "card_dismissed")}
    by_kind = {k: {t: 0 for t in counts} for k in CARD_KINDS}
    for e in events:
        if e["type"] in counts:
            counts[e["type"]] += 1
            kind = e["payload"].get("kind")
            if kind in by_kind:
                by_kind[kind][e["type"]] += 1
    kinds = {
        k: OpenRate(
            shown=v["card_shown"],
            opened=v["card_opened"],
            pinned=v["card_pinned"],
            dismissed=v["card_dismissed"],
            open_rate=round(v["card_opened"] / v["card_shown"], 4) if v["card_shown"] else 0.0,
        )
        for k, v in by_kind.items()
    }

    # Query latency and empty results, from the server's own query log.
    latencies: list[float] = []
    per_trigger: dict[str, list[int]] = {}
    for e in events:
        if e["type"] != "query_served" or e["payload"].get("abandoned"):
            continue
        lat = e["payload"].get("latencyMs")
        if isinstance(lat, (int, float)):
            latencies.append(float(lat))
        trig = e["trigger"] or "unknown"
        per_trigger.setdefault(trig, []).append(int(e["payload"].get("nCards", 0)))
    empty = {
        t: round(sum(1 for n in ns if n == 0) / len(ns), 4) for t, ns in sorted(per_trigger.items())
    }

    def rate(n: int, hours: int) -> float | None:
        return round(n / hours, 4) if hours else None

    return MetricsReport(
        since_days=since_days,
        generated_at=now.isoformat(timespec="seconds"),
        active_hours=len(active),
        external_lookups=lookups,
        lookups_per_active_hour=rate(lookups, len(active)),
        lookups_per_active_hour_rail_on=rate(lookups_on, active_on),
        lookups_per_active_hour_rail_off=rate(lookups_off, active_off),
        cards_shown=counts["card_shown"],
        cards_opened=counts["card_opened"],
        cards_pinned=counts["card_pinned"],
        cards_dismissed=counts["card_dismissed"],
        by_kind=kinds,
        latency_p50_ms=percentile(latencies, 50),
        latency_p95_ms=percentile(latencies, 95),
        queries=len(latencies),
        empty_rate_by_trigger=empty,
    )
