"""RRF fusion, calibration, ordering and exclude_self (design plan §9.5)."""

from __future__ import annotations

import sqlite3

from conftest import frame

from rail_server.models import ContextFrame
from rail_server.retrieve.planner import exclude_self, identifiers
from rail_server.retrieve.ranker import Candidate, calibrate, rank, rrf_fuse


def _row(
    id_: int,
    *,
    private: int = 0,
    repo: str | None = None,
    authored: str | None = None,
    path: str = "/x.py",
    start: int = 1,
    end: int = 5,
    qualname: str = "m.f",
    deleted: int = 0,
) -> sqlite3.Row:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    return conn.execute(
        "SELECT ? AS id, ? AS is_private, ? AS repo, ? AS authored_at, ? AS path, "
        "? AS start_line, ? AS end_line, ? AS qualname, ? AS deleted",
        (id_, private, repo, authored, path, start, end, qualname, deleted),
    ).fetchone()


def test_rrf_fuse() -> None:
    fused = rrf_fuse([1, 2, 3], [3, 4], k=60)
    ids = [i for i, _ in fused]
    assert ids[0] == 3  # in both lists
    assert set(ids) == {1, 2, 3, 4}
    assert abs(dict(fused)[1] - 1 / 61) < 1e-12


def test_calibrate() -> None:
    assert calibrate(0.4, 0.5) == 0.0
    assert calibrate(0.5, 0.5) == 0.5
    assert calibrate(1.0, 0.5) == 1.0
    assert 0.5 < calibrate(0.75, 0.5) < 1.0


def test_rank_orders_and_gates() -> None:
    cands = [
        Candidate(row=_row(1), kind="api", confidence=0.8, reason="nearby"),
        Candidate(row=_row(2), kind="api", confidence=1.0, reason="cursor", is_cursor=True),
        Candidate(row=_row(3, private=1), kind="api", confidence=0.8, reason="private"),
        Candidate(row=_row(4), kind="precedent", confidence=0.3, reason="weak"),
        Candidate(row=_row(1), kind="api", confidence=0.7, reason="dup lower"),
        Candidate(row=_row(2), kind="precedent", confidence=0.9, reason="same chunk as api"),
    ]
    ranked = rank(cands)
    assert [c.chunk_id for c in ranked] == [2, 1, 3]
    assert ranked[1].reason == "nearby"  # duplicate kept at its best confidence
    assert abs(ranked[2].confidence - 0.6) < 1e-9  # private down-ranked by 0.2
    assert all(c.kind == "api" for c in ranked)  # weak and duplicate precedents dropped


def test_rank_tie_breaks_same_repo_then_recency() -> None:
    cands = [
        Candidate(
            row=_row(1, repo="/other", authored="2024-05-01"),
            kind="precedent",
            confidence=0.7,
            reason="",
        ),
        Candidate(
            row=_row(2, repo="/mine", authored="2023-01-01"),
            kind="precedent",
            confidence=0.7,
            reason="",
        ),
        Candidate(
            row=_row(3, repo="/mine", authored="2024-01-01"),
            kind="precedent",
            confidence=0.7,
            reason="",
        ),
    ]
    assert [c.chunk_id for c in rank(cands, repo="/mine")] == [3, 2, 1]


def test_exclude_self() -> None:
    f = ContextFrame.model_validate(
        frame(
            docUri="file:///repo/a.py",
            enclosingText="def work(x):\n    return x\n",
            enclosingRange={"startLine": 9, "endLine": 20},
        )
    )
    rows = [
        _row(1, path="/repo/a.py", start=10, end=12, qualname="a.work"),  # the code being edited
        _row(2, path="/repo/a.py", start=40, end=45, qualname="a.work"),  # same def, lines moved
        _row(3, path="/repo/a.py", start=40, end=45, qualname="a.other"),
        _row(4, path="/repo/b.py", start=10, end=12, qualname="b.work"),
        _row(5, path="/repo/a.py", start=10, end=12, qualname="a.work", deleted=1),  # history
    ]
    assert [r["id"] for r in exclude_self(rows, f)] == [3, 4, 5]


def test_identifiers_skip_noise() -> None:
    ids = identifiers("def fetch_users(self, session):\n    return session.get(url)['users']")
    assert "fetch_users" in ids and "session" in ids
    assert "self" not in ids and "def" not in ids and "return" not in ids
