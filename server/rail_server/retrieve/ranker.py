"""Candidate ordering and the confidence gate (design plan §9.5, invariant I6)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from .store import Row

PRIVATE_PENALTY = 0.2
MIN_CONFIDENCE = 0.5


@dataclass
class Candidate:
    row: Row
    kind: str  # "api" | "precedent"
    confidence: float
    reason: str
    display: str | None = None
    is_cursor: bool = False
    cosine: float | None = None
    fused: float = 0.0
    active: str | int | None = None
    extra: dict[str, object] = field(default_factory=dict)

    @property
    def chunk_id(self) -> int:
        return int(self.row["id"])


def rrf_fuse(*rankings: list[int], k: int = 60) -> list[tuple[int, float]]:
    """Reciprocal-rank fusion. Scores order results; they are not calibrated."""
    scores: dict[int, float] = {}
    for ranking in rankings:
        for rank, item in enumerate(ranking):
            scores[item] = scores.get(item, 0.0) + 1.0 / (k + rank + 1)
    return sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))


def calibrate(cosine: float, threshold: float) -> float:
    """Map a cosine at or above the threshold onto [0.5, 1.0]."""
    if cosine < threshold:
        return 0.0
    span = max(1e-6, 1.0 - threshold)
    return min(1.0, 0.5 + 0.5 * (cosine - threshold) / span)


def _same_repo(row: Row, repo: str | None) -> bool:
    if not repo or not row["repo"]:
        return False
    return os.path.realpath(row["repo"]) == os.path.realpath(repo)


def rank(
    candidates: list[Candidate],
    *,
    repo: str | None = None,
    min_confidence: float = MIN_CONFIDENCE,
) -> list[Candidate]:
    best: dict[tuple[str, int], Candidate] = {}
    for c in candidates:
        if c.row["is_private"] and not c.extra.get("private_adjusted"):
            c.confidence -= PRIVATE_PENALTY
            c.extra["private_adjusted"] = True
        key = (c.kind, c.chunk_id)
        prev = best.get(key)
        if prev is None or (c.confidence, c.is_cursor) > (prev.confidence, prev.is_cursor):
            best[key] = c
    # An API card and a precedent card for the same chunk: keep the API card.
    api_ids = {cid for (kind, cid) in best if kind == "api"}
    kept = [
        c
        for (kind, cid), c in best.items()
        if c.confidence >= min_confidence and not (kind == "precedent" and cid in api_ids)
    ]
    kept.sort(
        key=lambda c: (
            -round(c.confidence, 6),
            not c.is_cursor,
            not _same_repo(c.row, repo),
            _neg_time(c.row["authored_at"]),
            -c.fused,
            c.chunk_id,
        )
    )
    return kept


def _neg_time(ts: str | None) -> str:
    # Later timestamps sort first: invert the ISO string's characters.
    if not ts:
        return "~"
    return "".join(chr(0x7E - (ord(ch) - 0x20)) if 0x20 <= ord(ch) <= 0x7E else ch for ch in ts)
