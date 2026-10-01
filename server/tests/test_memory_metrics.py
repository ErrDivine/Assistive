"""Lookup memory and the metrics math against a seeded event log (design plan §9.8)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from rail_server.memory import lookups
from rail_server.metrics.report import build_report, percentile
from rail_server.models import Event
from rail_server.store.db import open_db

NOW = datetime(2026, 3, 10, 18, 0, tzinfo=timezone.utc)


def ts(**kw: float) -> str:
    return (NOW - timedelta(**kw)).isoformat(timespec="milliseconds")


def test_frequent_needs_three_in_14_days(tmp_path: Path) -> None:
    conn = open_db(tmp_path / "db.sqlite")
    events = [
        Event(ts=ts(days=1), type="card_opened", qualname="a.f"),
        Event(ts=ts(days=2), type="card_opened", qualname="a.f"),
        Event(ts=ts(days=3), type="explicit_query", qualname="a.f"),
        Event(ts=ts(days=1), type="card_opened", qualname="b.g"),
        Event(ts=ts(days=2), type="card_opened", qualname="b.g"),
        Event(ts=ts(days=20), type="card_opened", qualname="b.g"),  # outside the window
        Event(ts=ts(days=1), type="card_shown", qualname="c.h"),
        Event(ts=ts(days=1), type="card_shown", qualname="c.h"),
        Event(ts=ts(days=1), type="card_shown", qualname="c.h"),
    ]
    lookups.log_events(conn, events)
    assert lookups.frequent_qualnames(conn, NOW) == [("a.f", 3)]
    lookups.pin(conn, "a.f", 1)
    assert lookups.frequent_qualnames(conn, NOW, exclude={"a.f"}) == []
    assert [r[0] for r in lookups.pins(conn)] == ["a.f"]
    lookups.unpin(conn, "a.f")
    assert lookups.pins(conn) == []


def seed(conn) -> None:  # type: ignore[no-untyped-def]
    ev: list[Event] = []
    # Hour A (rail on): 7 edit ticks → active.
    for m in range(7):
        ev.append(
            Event(ts=ts(hours=5, minutes=-m * 5), type="edit_tick", payload={"railEnabled": True})
        )
    # Hour B (rail off): 6 ticks → active.  Hour C: 2 ticks → not active.
    for m in range(6):
        ev.append(
            Event(ts=ts(hours=3, minutes=-m * 5), type="edit_tick", payload={"railEnabled": False})
        )
    for m in range(2):
        ev.append(
            Event(ts=ts(hours=1, minutes=-m * 5), type="edit_tick", payload={"railEnabled": True})
        )

    def blur(start: datetime, seconds: float, **payload: object) -> None:
        ev.append(
            Event(
                ts=start.isoformat(timespec="milliseconds"),
                type="focus_lost",
                payload={"debug": False, "msSinceLastEdit": 30_000, "railEnabled": True, **payload},
            )
        )
        ev.append(
            Event(
                ts=(start + timedelta(seconds=seconds)).isoformat(timespec="milliseconds"),
                type="focus_gained",
            )
        )

    base = NOW - timedelta(hours=5)
    blur(base + timedelta(minutes=1), 30)  # counts
    blur(base + timedelta(minutes=10), 120)  # counts
    blur(base + timedelta(minutes=20), 2)  # too short
    blur(base + timedelta(minutes=30), 900)  # too long
    blur(base + timedelta(minutes=50), 60, debug=True)  # debugging
    blur(base + timedelta(minutes=55), 60, msSinceLastEdit=600_000)  # no recent edit
    blur(NOW - timedelta(hours=3) + timedelta(minutes=1), 45, railEnabled=False)  # counts, off
    for kind, n_shown, n_open in (("api", 4, 2), ("precedent", 2, 1)):
        for i in range(n_shown):
            ev.append(Event(ts=ts(hours=4, minutes=i), type="card_shown", payload={"kind": kind}))
        for i in range(n_open):
            ev.append(Event(ts=ts(hours=4, minutes=i), type="card_opened", payload={"kind": kind}))
    ev.append(Event(ts=ts(hours=4), type="card_pinned", payload={"kind": "api"}))
    ev.append(Event(ts=ts(hours=4), type="card_dismissed", payload={"kind": "precedent"}))
    for i, (lat, n, trig) in enumerate(
        [
            (10, 1, "cursor_pause"),
            (20, 0, "cursor_pause"),
            (30, 2, "edit_pause"),
            (40, 0, "edit_pause"),
            (500, 0, "edit_pause"),
        ]
    ):
        ev.append(
            Event(
                ts=ts(hours=2, minutes=i),
                type="query_served",
                trigger=trig,
                payload={"latencyMs": lat, "nCards": n},
            )
        )
    ev.append(
        Event(
            ts=ts(hours=2),
            type="query_served",
            trigger="cursor_pause",
            payload={"latencyMs": 9999, "nCards": 0, "abandoned": True},
        )
    )
    lookups.log_events(conn, ev)


def test_metrics_report_from_seeded_log(tmp_path: Path) -> None:
    conn = open_db(tmp_path / "db.sqlite")
    seed(conn)
    r = build_report(conn, 14, NOW)
    assert r.active_hours == 2
    assert r.external_lookups == 3
    assert r.lookups_per_active_hour == 1.5
    assert r.lookups_per_active_hour_rail_on == 2.0
    assert r.lookups_per_active_hour_rail_off == 1.0
    assert (r.cards_shown, r.cards_opened, r.cards_pinned, r.cards_dismissed) == (6, 3, 1, 1)
    assert r.by_kind["api"].open_rate == 0.5 and r.by_kind["precedent"].open_rate == 0.5
    assert r.queries == 5
    assert r.latency_p50_ms == 30 and r.latency_p95_ms == 500
    assert r.empty_rate_by_trigger == {"cursor_pause": 0.5, "edit_pause": round(2 / 3, 4)}
    wire = r.wire()
    for key in ("lookupsPerActiveHour", "latencyP95Ms", "emptyRateByTrigger", "byKind"):
        assert key in wire


def test_window_excludes_old_events(tmp_path: Path) -> None:
    conn = open_db(tmp_path / "db.sqlite")
    seed(conn)
    assert build_report(conn, 0, NOW).cards_shown == 0


def test_percentile_nearest_rank() -> None:
    assert percentile([], 50) is None
    assert percentile([5.0], 95) == 5.0
    assert percentile([1, 2, 3, 4], 50) == 2
    assert percentile(list(range(1, 101)), 95) == 95
