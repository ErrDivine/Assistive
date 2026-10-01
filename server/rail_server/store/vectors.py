"""Vector index behind an interface (design plan §5, §10).

v1 is brute force. Vectors are stored as float16 in SQLite (§7.1); in memory
the index keeps an int8 copy with one float32 scale per row (DECISIONS.md
D-023): converting float16 to float32 on every query dominated the search time
(~500 ms for 200k × 896 dims), while int8 → float32 + BLAS takes ~65 ms at half
the memory. The ranking pass uses the int8 scores (max error ~1e-3); the
cosine gate (``scores``) is computed exactly from the stored float16 vectors.
If this still misses the budget on a real index, an approximate index can
replace ``BruteForceIndex`` behind ``VectorIndex`` (needs a decision record).
"""

from __future__ import annotations

import sqlite3
import threading
from abc import ABC, abstractmethod
from collections.abc import Callable
from typing import Any

import numpy as np

BLOCK = 8192

ExactLoader = Callable[[list[int]], dict[int, np.ndarray]]


class VectorIndex(ABC):
    @abstractmethod
    def load(self, conn: sqlite3.Connection, model: str) -> None: ...

    @abstractmethod
    def upsert(self, ids: list[int], vecs: np.ndarray) -> None: ...

    @abstractmethod
    def remove(self, ids: list[int]) -> None: ...

    @abstractmethod
    def search(self, query: np.ndarray, k: int) -> list[tuple[int, float]]: ...

    @abstractmethod
    def scores(self, query: np.ndarray, ids: list[int]) -> dict[int, float]: ...

    @abstractmethod
    def __len__(self) -> int: ...


def quantize(vecs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Symmetric per-row int8 quantization: ``vec ≈ q * scale``."""
    f = np.asarray(vecs, dtype=np.float32)
    if f.ndim == 1:
        f = f.reshape(1, -1)
    peak = np.abs(f).max(axis=1)
    scale = np.where(peak > 0, peak / 127.0, 1.0).astype(np.float32)
    q = np.clip(np.rint(f / scale[:, None]), -127, 127).astype(np.int8)
    return q, scale


class BruteForceIndex(VectorIndex):
    def __init__(self, exact_loader: ExactLoader | None = None) -> None:
        self._ids: np.ndarray[Any, np.dtype[np.int64]] = np.zeros(0, dtype=np.int64)
        self._q: np.ndarray[Any, np.dtype[np.int8]] = np.zeros((0, 0), dtype=np.int8)
        self._scale: np.ndarray[Any, np.dtype[np.float32]] = np.zeros(0, dtype=np.float32)
        self._pos: dict[int, int] = {}
        self._lock = threading.RLock()
        self.exact_loader = exact_loader
        self.model: str | None = None
        self.dim = 0

    def __len__(self) -> int:
        return int(self._ids.shape[0])

    @property
    def nbytes(self) -> int:
        return int(self._q.nbytes + self._scale.nbytes + self._ids.nbytes)

    def load(self, conn: sqlite3.Connection, model: str) -> None:
        cur = conn.execute(
            "SELECT e.chunk_id, e.dim, e.vec FROM embeddings e JOIN chunks c ON c.id = e.chunk_id "
            "WHERE e.model = ? AND c.kind = 'code' ORDER BY e.chunk_id",
            (model,),
        )
        ids: list[int] = []
        qs: list[np.ndarray] = []
        scales: list[np.ndarray] = []
        dim = 0
        while True:
            rows = cur.fetchmany(4096)
            if not rows:
                break
            dim = int(rows[0][1])
            block = np.stack([np.frombuffer(r[2], dtype=np.float16, count=dim) for r in rows])
            q, s = quantize(block)
            ids.extend(int(r[0]) for r in rows)
            qs.append(q)
            scales.append(s)
        with self._lock:
            self._ids = np.array(ids, dtype=np.int64)
            self._q = np.vstack(qs) if qs else np.zeros((0, dim), dtype=np.int8)
            self._scale = np.concatenate(scales) if scales else np.zeros(0, dtype=np.float32)
            self.dim, self.model = dim, model
            self._pos = {int(c): i for i, c in enumerate(self._ids)}

    def upsert(self, ids: list[int], vecs: np.ndarray) -> None:
        if not ids:
            return
        q, s = quantize(np.asarray(vecs, dtype=np.float32))
        with self._lock:
            if self.dim == 0:
                self.dim = int(q.shape[1])
                self._q = np.zeros((0, self.dim), dtype=np.int8)
            new_ids, new_rows, new_scales = [], [], []
            for j, cid in enumerate(ids):
                i = self._pos.get(int(cid))
                if i is not None:
                    self._q[i] = q[j]
                    self._scale[i] = s[j]
                else:
                    new_ids.append(int(cid))
                    new_rows.append(q[j])
                    new_scales.append(s[j])
            if new_ids:
                start = len(self._ids)
                self._ids = np.concatenate([self._ids, np.array(new_ids, dtype=np.int64)])
                self._q = np.vstack([self._q, np.stack(new_rows)])
                self._scale = np.concatenate([self._scale, np.array(new_scales, np.float32)])
                for j, cid in enumerate(new_ids):
                    self._pos[cid] = start + j

    def remove(self, ids: list[int]) -> None:
        with self._lock:
            drop = {int(i) for i in ids if int(i) in self._pos}
            if not drop:
                return
            keep = np.array([int(c) not in drop for c in self._ids], dtype=bool)
            self._ids = self._ids[keep]
            self._q = self._q[keep]
            self._scale = self._scale[keep]
            self._pos = {int(c): i for i, c in enumerate(self._ids)}

    def _all_scores(self, q: np.ndarray) -> np.ndarray:
        out = np.empty(len(self._ids), dtype=np.float32)
        for s in range(0, len(self._ids), BLOCK):
            out[s : s + BLOCK] = self._q[s : s + BLOCK].astype(np.float32) @ q
        return out * self._scale

    def search(self, query: np.ndarray, k: int) -> list[tuple[int, float]]:
        q = np.asarray(query, dtype=np.float32).reshape(-1)
        with self._lock:
            n = len(self._ids)
            if n == 0 or q.shape[0] != self.dim:
                return []
            scores = self._all_scores(q)
            # Over-fetch with the int8 scores, then order by exact cosine so
            # quantization noise never reorders near-ties (RRF uses ranks).
            m = min(n, max(k * 3, k + 16))
            top = np.argpartition(-scores, m - 1)[:m]
            approx = [(int(self._ids[i]), float(scores[i])) for i in top]
        exact = self.scores(q, [cid for cid, _ in approx]) if self.exact_loader else {}
        ranked = sorted(approx, key=lambda t: (-exact.get(t[0], t[1]), t[0]))[: min(k, n)]
        return [(cid, exact.get(cid, sc)) for cid, sc in ranked]

    def scores(self, query: np.ndarray, ids: list[int]) -> dict[int, float]:
        """Exact cosines (from the stored float16 vectors when a loader is set)."""
        q = np.asarray(query, dtype=np.float32).reshape(-1)
        with self._lock:
            if q.shape[0] != self.dim:
                return {}
            known = [int(c) for c in ids if int(c) in self._pos]
        if not known:
            return {}
        if self.exact_loader is not None:
            exact = self.exact_loader(known)
            out = {
                cid: float(np.asarray(v, dtype=np.float32) @ q)
                for cid, v in exact.items()
                if len(v) == self.dim
            }
            if len(out) == len(known):
                return out
        with self._lock:
            return {
                cid: float(
                    self._q[self._pos[cid]].astype(np.float32) @ q * self._scale[self._pos[cid]]
                )
                for cid in known
                if cid in self._pos
            }
