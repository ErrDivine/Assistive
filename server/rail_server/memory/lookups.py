"""Lookup memory (design plan §9.8): the event log, pins and Frequent lookups."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone

from ..models import Event
from ..store.db import transaction

FREQUENT_MIN_COUNT = 3
FREQUENT_WINDOW_DAYS = 14
FREQUENT_MAX = 5
FREQUENT_EVENT_TYPES = ("card_opened", "explicit_query")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def log_events(conn: sqlite3.Connection, events: list[Event]) -> int:
    with transaction(conn):
        conn.executemany(
            "INSERT INTO events(ts, type, card_id, qualname, trigger, payload) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            [
                (
                    e.ts or now_iso(),
                    e.type,
                    e.card_id,
                    e.qualname,
                    e.trigger,
                    json.dumps(e.payload) if e.payload is not None else None,
                )
                for e in events
            ],
        )
    return len(events)


def frequent_qualnames(
    conn: sqlite3.Connection, now: datetime | None = None, *, exclude: set[str] | None = None
) -> list[tuple[str, int]]:
    """Qualnames opened or asked about ≥ 3 times in a sliding 14-day window."""
    now = now or datetime.now(timezone.utc)
    since = (now - timedelta(days=FREQUENT_WINDOW_DAYS)).isoformat(timespec="milliseconds")
    rows = conn.execute(
        "SELECT qualname, COUNT(*) AS n, MAX(ts) AS last FROM events "
        f"WHERE type IN ({','.join('?' for _ in FREQUENT_EVENT_TYPES)}) "
        "AND qualname IS NOT NULL AND ts >= ? "
        "GROUP BY qualname HAVING n >= ? ORDER BY n DESC, last DESC",
        (*FREQUENT_EVENT_TYPES, since, FREQUENT_MIN_COUNT),
    ).fetchall()
    out = [(r[0], int(r[1])) for r in rows if not exclude or r[0] not in exclude]
    return out[:FREQUENT_MAX]


def pin(conn: sqlite3.Connection, qualname: str, chunk_id: int) -> None:
    with transaction(conn):
        conn.execute(
            "INSERT INTO pins(qualname, chunk_id, pinned_at) VALUES (?, ?, ?) "
            "ON CONFLICT(qualname) DO UPDATE SET chunk_id = excluded.chunk_id",
            (qualname, chunk_id, now_iso()),
        )


def unpin(conn: sqlite3.Connection, qualname: str) -> None:
    with transaction(conn):
        conn.execute("DELETE FROM pins WHERE qualname = ?", (qualname,))


def pins(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT qualname, chunk_id, pinned_at FROM pins ORDER BY pinned_at"
    ).fetchall()
