"""Indexing jobs. These run in a separate process (``ProcessPoolExecutor``) so
queries stay responsive (design plan §4). Progress travels back on a queue."""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

from ..store.db import open_db, set_meta
from .code import embed_missing, index_roots, resolve_roots
from .embeddings import get_embedder
from .library import sync_library

log = logging.getLogger(__name__)

_queue: Any = None
_stop: Any = None


def init_worker(queue: Any, stop: Any, parent_pid: int) -> None:
    global _queue, _stop
    _queue, _stop = queue, stop
    logging.basicConfig(level=logging.INFO, format="[rail-index] %(levelname)s %(message)s")

    def watch_parent() -> None:
        # If the server dies (e.g. it was killed), do not linger as an orphan.
        while True:
            time.sleep(2.0)
            if os.getppid() != parent_pid:
                os._exit(0)

    threading.Thread(target=watch_parent, daemon=True).start()


def _progress(phase: str, done: int, total: int, message: str) -> None:
    if _queue is not None:
        try:
            _queue.put_nowait({"phase": phase, "done": done, "total": total, "message": message})
        except Exception:
            pass


def _should_stop() -> bool:
    return bool(_stop is not None and _stop.is_set())


def run_sync(
    cfg: dict[str, Any],
    probe: dict[str, Any] | None,
    roots: list[str],
    extra_repos: list[str],
    *,
    library: bool = True,
    workspace: bool = True,
    history: bool = True,
) -> dict[str, Any]:
    """Full sync: libraries, workspace code, embeddings, then git history."""
    t0 = time.monotonic()
    result: dict[str, Any] = {}
    db_path = cfg["db_path"]
    if library and probe is not None:
        result["library"] = sync_library(
            db_path,
            probe,
            workspace_roots=roots + extra_repos,
            index_stdlib=cfg.get("index_stdlib", True),
            progress=_progress,
            should_stop=_should_stop,
        )
    conn = open_db(db_path)
    try:
        resolved = resolve_roots([*roots, *extra_repos])
        if workspace and resolved and not _should_stop():
            result["workspace"] = index_roots(
                conn, resolved, progress=_progress, should_stop=_should_stop
            )
        embedder = get_embedder(
            cfg["embedding_backend"], cfg["embedding_model"], Path(cfg["models_dir"])
        )
        result["embedder"] = embedder.name
        if not _should_stop():
            result["embedded"] = embed_missing(
                conn, embedder, progress=_progress, should_stop=_should_stop
            )
            _progress("embeddings", 1, 1, "embeddings ready")
        # Git history runs last, at low priority (design plan §9.4).
        if history and cfg.get("history_depth", 0) > 0 and resolved and not _should_stop():
            from .git_history import index_history

            result["history"] = index_history(
                conn,
                resolved,
                depth=int(cfg["history_depth"]),
                embedder=embedder,
                progress=_progress,
                should_stop=_should_stop,
            )
            if not _should_stop():
                result["embedded"] += embed_missing(
                    conn, embedder, progress=_progress, should_stop=_should_stop
                )
                _progress("embeddings", 1, 1, "embeddings ready")
        conn.execute("ANALYZE")
        set_meta(conn, "last_sync", time.strftime("%Y-%m-%dT%H:%M:%S%z"))
        conn.commit()
    finally:
        conn.close()
    result["seconds"] = round(time.monotonic() - t0, 2)
    _progress("done", 1, 1, "index up to date")
    return result
