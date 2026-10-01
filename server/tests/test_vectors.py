"""Vector store: int8 ranking pass, exact cosine gate, latency at 200k chunks (§10)."""

from __future__ import annotations

import sqlite3
import time

import numpy as np

from rail_server.store.vectors import BruteForceIndex, quantize


def _unit(rng: np.random.Generator, n: int, dim: int) -> np.ndarray:
    v = rng.standard_normal((n, dim), dtype=np.float32)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def test_quantization_error_is_small() -> None:
    rng = np.random.default_rng(1)
    v = _unit(rng, 1000, 384)
    q, s = quantize(v)
    approx = q.astype(np.float32) * s[:, None]
    assert np.abs(approx - v).max() < 0.01
    query = _unit(rng, 1, 384)[0]
    assert np.abs(approx @ query - v @ query).max() < 0.005


def test_search_upsert_remove_and_exact_scores() -> None:
    rng = np.random.default_rng(2)
    v = _unit(rng, 500, 64)
    exact_rows = {i: v[i].astype(np.float16) for i in range(500)}
    idx = BruteForceIndex(lambda ids: {i: exact_rows[i] for i in ids})
    idx.upsert(list(range(500)), v)
    hits = idx.search(v[42], 5)
    assert hits[0][0] == 42 and abs(hits[0][1] - 1.0) < 0.01
    # The gate uses the stored float16 vectors, not the int8 copy.
    s = idx.scores(v[42], [42, 7])
    assert abs(s[42] - float(exact_rows[42].astype(np.float32) @ v[42])) < 1e-6
    idx.remove([42])
    assert all(cid != 42 for cid, _ in idx.search(v[42], 5))
    assert 42 not in idx.scores(v[42], [42])
    idx.upsert([7], v[8:9])  # replace in place
    assert idx.search(v[8], 2)[0][0] in (7, 8)
    assert len(idx) == 499


def test_load_from_sqlite_matches_upsert() -> None:
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        "CREATE TABLE chunks (id INTEGER PRIMARY KEY, kind TEXT);"
        "CREATE TABLE embeddings (chunk_id INTEGER, model TEXT, dim INTEGER, vec BLOB);"
    )
    rng = np.random.default_rng(3)
    v = _unit(rng, 50, 32)
    for i in range(50):
        conn.execute("INSERT INTO chunks VALUES (?, 'code')", (i,))
        conn.execute(
            "INSERT INTO embeddings VALUES (?, 'm', 32, ?)", (i, v[i].astype(np.float16).tobytes())
        )
    conn.execute(
        "INSERT INTO embeddings VALUES (99, 'other', 32, ?)", (v[0].astype(np.float16).tobytes(),)
    )
    idx = BruteForceIndex()
    idx.load(conn, "m")
    assert len(idx) == 50 and idx.search(v[10], 1)[0][0] == 10


def test_brute_force_latency_at_200k_chunks() -> None:
    """§10: precedent search over ≤ 200k code chunks must keep p95 ≤ 400 ms; the
    vector pass gets well under half of that (hybrid vectors are 896-d)."""
    rng = np.random.default_rng(4)
    n, dim = 200_000, 896
    idx = BruteForceIndex()
    for start in range(0, n, 20_000):
        idx.upsert(list(range(start, start + 20_000)), _unit(rng, 20_000, dim))
    assert idx.nbytes < 200 * 2**20  # int8: ~171 MB
    q = _unit(rng, 1, dim)[0]
    lat = []
    for _ in range(15):
        t = time.perf_counter()
        idx.search(q, 20)
        lat.append((time.perf_counter() - t) * 1000)
    lat.sort()
    assert lat[13] < 200, f"p95 {lat[13]:.0f} ms"
