"""Vector index behind an interface (design plan §5, §10).

v1 is brute force over float16 vectors held in memory. If it misses the
latency budget on a real index, an approximate index can replace
``BruteForceIndex`` behind ``VectorIndex`` (needs a decision record first).
"""

from __future__ import annotations

import sqlite3
import threading
from abc import ABC, abstractmethod

import numpy as np

BLOCK = 16384


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


class BruteForceIndex(VectorIndex):
    def __init__(self) -> None:
        self._ids = np.zeros(0, dtype=np.int64)
        self._mat = np.zeros((0, 0), dtype=np.float16)
        self._pos: dict[int, int] = {}
        self._lock = threading.RLock()
        self.model: str | None = None
        self.dim = 0

    def __len__(self) -> int:
        return int(self._ids.shape[0])

    def load(self, conn: sqlite3.Connection, model: str) -> None:
        rows = conn.execute(
            "SELECT e.chunk_id, e.dim, e.vec FROM embeddings e JOIN chunks c ON c.id = e.chunk_id "
            "WHERE e.model = ? AND c.kind = 'code' ORDER BY e.chunk_id",
            (model,),
        ).fetchall()
        dim = int(rows[0][1]) if rows else 0
        ids = np.fromiter((int(r[0]) for r in rows), dtype=np.int64, count=len(rows))
        mat = np.zeros((len(rows), dim), dtype=np.float16)
        for i, r in enumerate(rows):
            mat[i] = np.frombuffer(r[2], dtype=np.float16, count=dim)
        with self._lock:
            self._ids, self._mat, self.dim, self.model = ids, mat, dim, model
            self._pos = {int(c): i for i, c in enumerate(ids)}

    def upsert(self, ids: list[int], vecs: np.ndarray) -> None:
        if not ids:
            return
        vecs = np.asarray(vecs, dtype=np.float16)
        with self._lock:
            if self.dim == 0:
                self.dim = int(vecs.shape[1])
                self._mat = np.zeros((0, self.dim), dtype=np.float16)
            new_ids, new_rows = [], []
            for cid, v in zip(ids, vecs):
                i = self._pos.get(int(cid))
                if i is not None:
                    self._mat[i] = v
                else:
                    new_ids.append(int(cid))
                    new_rows.append(v)
            if new_ids:
                start = len(self._ids)
                self._ids = np.concatenate([self._ids, np.array(new_ids, dtype=np.int64)])
                self._mat = np.vstack([self._mat, np.stack(new_rows)])
                for j, cid in enumerate(new_ids):
                    self._pos[cid] = start + j

    def remove(self, ids: list[int]) -> None:
        with self._lock:
            drop = {int(i) for i in ids if int(i) in self._pos}
            if not drop:
                return
            keep = np.array([int(c) not in drop for c in self._ids], dtype=bool)
            self._ids = self._ids[keep]
            self._mat = self._mat[keep]
            self._pos = {int(c): i for i, c in enumerate(self._ids)}

    def _all_scores(self, q: np.ndarray) -> np.ndarray:
        out = np.empty(len(self._ids), dtype=np.float32)
        for s in range(0, len(self._ids), BLOCK):
            block = self._mat[s : s + BLOCK].astype(np.float32)
            out[s : s + BLOCK] = block @ q
        return out

    def search(self, query: np.ndarray, k: int) -> list[tuple[int, float]]:
        q = np.asarray(query, dtype=np.float32).reshape(-1)
        with self._lock:
            n = len(self._ids)
            if n == 0 or q.shape[0] != self.dim:
                return []
            scores = self._all_scores(q)
            k = min(k, n)
            top = np.argpartition(-scores, k - 1)[:k]
            top = top[np.argsort(-scores[top], kind="stable")]
            return [(int(self._ids[i]), float(scores[i])) for i in top]

    def scores(self, query: np.ndarray, ids: list[int]) -> dict[int, float]:
        q = np.asarray(query, dtype=np.float32).reshape(-1)
        out: dict[int, float] = {}
        with self._lock:
            if q.shape[0] != self.dim:
                return out
            for cid in ids:
                i = self._pos.get(int(cid))
                if i is not None:
                    out[int(cid)] = float(self._mat[i].astype(np.float32) @ q)
        return out
