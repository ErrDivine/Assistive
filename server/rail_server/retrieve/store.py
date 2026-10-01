"""Read-side queries over the index, scoped to the active environment's dists."""

from __future__ import annotations

import os
import sqlite3
import threading
from collections import OrderedDict
from typing import Any

from ..index.library import RUNTIME_DIST, RUNTIME_SCHEME, STDLIB_DIST
from ..index.pyast import IDENT, split_lines
from ..store.db import ConnectionPool

Row = sqlite3.Row


class LineCache:
    """mtime-checked cache of file lines (used for verification and lookups)."""

    def __init__(self, capacity: int = 256) -> None:
        self._data: OrderedDict[str, tuple[float, int, list[str]]] = OrderedDict()
        self._cap = capacity
        self._lock = threading.Lock()

    def lines(self, path: str) -> list[str] | None:
        try:
            st = os.stat(path)
        except OSError:
            return None
        with self._lock:
            hit = self._data.get(path)
            if hit and hit[0] == st.st_mtime and hit[1] == st.st_size:
                self._data.move_to_end(path)
                return hit[2]
        try:
            with open(path, "rb") as fh:
                raw = fh.read()
        except OSError:
            return None
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("latin-1")
        lines = split_lines(text)
        with self._lock:
            self._data[path] = (st.st_mtime, st.st_size, lines)
            self._data.move_to_end(path)
            while len(self._data) > self._cap:
                self._data.popitem(last=False)
        return lines

    def invalidate(self, path: str) -> None:
        with self._lock:
            self._data.pop(path, None)


def path_variants(path: str) -> list[str]:
    out = [path]
    for p in (os.path.abspath(path), os.path.realpath(path)):
        if p not in out:
            out.append(p)
    return out


def ident_at(line: str, character: int) -> str | None:
    for m in IDENT.finditer(line):
        if m.start() <= character <= m.end():
            return m.group(0)
    return None


class Store:
    def __init__(self, pool: ConnectionPool) -> None:
        self.pool = pool
        self.lines = LineCache()
        self._active: list[tuple[str, str]] = []
        self._active_set: set[tuple[str, str]] = set()
        self._active_sql = "0"
        self._active_params: tuple[str, ...] = ()
        self.python_version: str | None = None

    # -- scope ------------------------------------------------------------
    def set_active(self, pairs: list[tuple[str, str]], python_version: str | None) -> None:
        self._active = list(dict.fromkeys(pairs))
        self._active_set = set(self._active)
        self.python_version = python_version
        if self._active:
            values = ",".join("(?,?)" for _ in self._active)
            self._active_sql = f"(dist_name, dist_version) IN (VALUES {values})"
            self._active_params = tuple(x for pair in self._active for x in pair)
        else:
            self._active_sql = "0"
            self._active_params = ()

    @property
    def conn(self) -> sqlite3.Connection:
        return self.pool.get()

    def _api_scope(self) -> tuple[str, tuple[str, ...]]:
        return f"(kind = 'code' OR {self._active_sql})", self._active_params

    # -- chunk access -----------------------------------------------------
    def chunk(self, chunk_id: int) -> Row | None:
        return self.conn.execute("SELECT * FROM chunks WHERE id = ?", (chunk_id,)).fetchone()

    def chunks(self, ids: list[int]) -> dict[int, Row]:
        if not ids:
            return {}
        out: dict[int, Row] = {}
        for i in range(0, len(ids), 500):
            part = ids[i : i + 500]
            q = f"SELECT * FROM chunks WHERE id IN ({','.join('?' for _ in part)})"
            for r in self.conn.execute(q, part):
                out[int(r["id"])] = r
        return out

    def by_qualname(self, qualname: str) -> Row | None:
        """An API chunk with this exact qualname, preferring source over runtime docs."""
        rows = self.conn.execute(
            "SELECT * FROM chunks INDEXED BY chunks_qualname WHERE qualname = ? AND kind = 'api' "
            f"AND {self._active_sql} "
            "ORDER BY (origin = 'runtime_doc') ASC, (dist_name = ?) ASC LIMIT 1",
            (qualname, *self._active_params, STDLIB_DIST),
        ).fetchall()
        return rows[0] if rows else None

    def alias_target(self, alias: str) -> str | None:
        row = self.conn.execute(
            f"SELECT target FROM aliases WHERE alias = ? AND {self._active_sql} LIMIT 1",
            (alias, *self._active_params),
        ).fetchone()
        return row[0] if row else None

    def lookup(self, qualname: str, *, max_hops: int = 6) -> Row | None:
        """Resolve ``qualname`` following re-export aliases (``requests.get`` →
        ``requests.api.get``), including aliases of any prefix."""
        seen: set[str] = set()
        current = qualname
        for _ in range(max_hops):
            if current in seen:
                return None
            seen.add(current)
            row = self.by_qualname(current)
            if row is not None:
                return row
            parts = current.split(".")
            replaced = None
            for i in range(len(parts), 0, -1):
                head = ".".join(parts[:i])
                target = self.alias_target(head)
                if target and target != head:
                    replaced = ".".join([target, *parts[i:]])
                    break
                if i < len(parts):
                    # ``from X import *`` re-exports: M.name → X.name
                    star = self.alias_target(head + ".*")
                    if star and self.by_qualname(".".join([star, *parts[i:]])) is not None:
                        replaced = ".".join([star, *parts[i:]])
                        break
            if replaced is None:
                return None
            current = replaced
        return None

    def module_exists(self, module: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM chunks INDEXED BY chunks_qualname WHERE qualname = ? AND kind = 'api' "
            f"AND {self._active_sql} LIMIT 1",
            (module, *self._active_params),
        ).fetchone()
        return row is not None

    def by_span(
        self, path: str, line1: int, *, kinds: tuple[str, ...] = ("api", "code")
    ) -> list[Row]:
        """Chunks in ``path`` containing 1-based ``line1``, innermost first."""
        kind_sql = ",".join("?" for _ in kinds)
        scope, params = self._api_scope()
        out: list[Row] = []
        for p in path_variants(path):
            out = self.conn.execute(
                "SELECT * FROM chunks INDEXED BY chunks_path_lines "
                "WHERE path = ? AND start_line <= ? AND end_line >= ? "
                f"AND kind IN ({kind_sql}) AND deleted = 0 AND {scope} "
                "ORDER BY (end_line - start_line) ASC LIMIT 8",
                (p, line1, line1, *kinds, *params),
            ).fetchall()
            if out:
                break
        return out

    def by_suffix(
        self, ident: str, prefixes: list[str] | None = None, limit: int = 20
    ) -> list[Row]:
        """API chunks whose qualname ends with ``.ident`` (optionally under prefixes)."""
        if not IDENT.fullmatch(ident.split(".")[-1]):
            return []
        last = ident.split(".")[-1]
        try:
            ids = [
                int(r[0])
                for r in self.conn.execute(
                    "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 2000",
                    (f'qualname:"{last}"',),
                )
            ]
        except sqlite3.OperationalError:
            return []
        rows = [
            r
            for r in self.chunks(ids).values()
            if r["kind"] == "api" and (r["dist_name"], r["dist_version"]) in self._active_set
        ]
        suffix = "." + ident
        out = [
            r
            for r in rows
            if r["qualname"] and (r["qualname"].endswith(suffix) or r["qualname"] == ident)
        ]
        if prefixes:
            pref = tuple(p + "." for p in prefixes)
            out = [r for r in out if r["qualname"].startswith(pref)]
        out.sort(key=lambda r: (r["is_private"], len(r["qualname"])))
        return out[:limit]

    def runtime_lines(self, path: str) -> list[str] | None:
        """Rebuild the virtual document of a runtime-introspected module."""
        from ..index.library import render_runtime

        rows = self.conn.execute(
            "SELECT qualname, signature, docstring FROM chunks WHERE path = ? ORDER BY start_line",
            (path,),
        ).fetchall()
        if not rows:
            return None
        entries = [{"qualname": r[0], "signature": r[1], "doc": r[2]} for r in rows]
        lines, _ = render_runtime(entries)
        return lines

    def file_row(self, path: str) -> Row | None:
        return self.conn.execute("SELECT * FROM files WHERE path = ?", (path,)).fetchone()

    def stats(self) -> dict[str, Any]:
        c = self.conn
        dists = c.execute(
            "SELECT COUNT(*) FROM indexed_dists WHERE dist_name NOT IN (?, ?)",
            (STDLIB_DIST, RUNTIME_DIST),
        ).fetchone()[0]
        chunks = c.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        code = c.execute("SELECT COUNT(*) FROM chunks WHERE kind = 'code'").fetchone()[0]
        embedded = c.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0]
        return {"dists": dists, "chunks": chunks, "codeChunks": code, "embedded": embedded}


def is_runtime_path(path: str) -> bool:
    return path.startswith(RUNTIME_SCHEME)
