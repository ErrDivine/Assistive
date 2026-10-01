"""SQLite schema, migrations and the FTS5 startup check (design plan §7.1)."""

from __future__ import annotations

import logging
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

log = logging.getLogger(__name__)

SCHEMA_VERSION = 2


class Fts5Unavailable(RuntimeError):
    pass


def check_fts5() -> None:
    """Exit early with a clear message if this SQLite build lacks FTS5."""
    conn = sqlite3.connect(":memory:")
    try:
        conn.execute("CREATE VIRTUAL TABLE fts5_probe USING fts5(x)")
    except sqlite3.OperationalError as e:
        raise Fts5Unavailable(
            f"SQLite {sqlite3.sqlite_version} was built without FTS5, which Reference Rail "
            "requires. Use a Python whose sqlite3 module includes FTS5 (python.org, "
            "uv-managed and most distro builds do)."
        ) from e
    finally:
        conn.close()


_MIGRATIONS: dict[int, str] = {
    1: """
CREATE TABLE IF NOT EXISTS files (
  path          TEXT PRIMARY KEY,
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('library','workspace','history')),
  dist_name     TEXT, dist_version TEXT,
  repo          TEXT,
  mtime REAL, size INTEGER, content_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  -- AUTOINCREMENT: ids are never reused, so card ids (hash of kind, chunk id)
  -- never point at a different chunk after a re-index (DECISIONS.md D-005).
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL CHECK (kind IN ('api','code')),
  qualname      TEXT,
  path          TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  start_line    INTEGER NOT NULL, end_line INTEGER NOT NULL,
  signature     TEXT,
  docstring     TEXT,
  doc_sections  TEXT,
  raises_scan   TEXT,
  body          TEXT,
  dist_name TEXT, dist_version TEXT,
  repo TEXT, commit_sha TEXT, authored_at TEXT,
  deleted       INTEGER NOT NULL DEFAULT 0,
  is_private    INTEGER NOT NULL DEFAULT 0,
  origin        TEXT NOT NULL DEFAULT 'source' CHECK (origin IN ('source','runtime_doc')),
  -- Extensions (DECISIONS.md D-005): where the defined name sits, the
  -- docstring's first line, the file path relative to its repo, and a hash
  -- of the chunk text used to keep ids/embeddings stable on re-index.
  name_line     INTEGER,
  doc_line      INTEGER,
  rel_path      TEXT,
  chunk_hash    TEXT
);
CREATE INDEX IF NOT EXISTS chunks_qualname ON chunks(qualname);
CREATE INDEX IF NOT EXISTS chunks_path_lines ON chunks(path, start_line, end_line);
CREATE INDEX IF NOT EXISTS chunks_dist ON chunks(dist_name, dist_version);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  qualname, signature, docstring, body,
  content='chunks', content_rowid='id', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, qualname, signature, docstring, body)
  VALUES (new.id, new.qualname, new.signature, new.docstring, new.body);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, qualname, signature, docstring, body)
  VALUES ('delete', old.id, old.qualname, old.signature, old.docstring, old.body);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, qualname, signature, docstring, body)
  VALUES ('delete', old.id, old.qualname, old.signature, old.docstring, old.body);
  INSERT INTO chunks_fts(rowid, qualname, signature, docstring, body)
  VALUES (new.id, new.qualname, new.signature, new.docstring, new.body);
END;

CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS indexed_dists (
  dist_name TEXT, dist_version TEXT, indexed_at TEXT,
  PRIMARY KEY (dist_name, dist_version)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  card_id TEXT, qualname TEXT, trigger TEXT,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_type_ts ON events(type, ts);

CREATE TABLE IF NOT EXISTS pins (qualname TEXT PRIMARY KEY, chunk_id INTEGER, pinned_at TEXT);

-- Extensions (DECISIONS.md D-005).
CREATE TABLE IF NOT EXISTS aliases (
  alias TEXT NOT NULL, target TEXT NOT NULL,
  dist_name TEXT NOT NULL, dist_version TEXT NOT NULL,
  PRIMARY KEY (alias, dist_name, dist_version)
);
CREATE INDEX IF NOT EXISTS aliases_alias ON aliases(alias);
CREATE INDEX IF NOT EXISTS aliases_target ON aliases(target);
CREATE TABLE IF NOT EXISTS indexed_history (
  repo TEXT NOT NULL, commit_sha TEXT NOT NULL,
  PRIMARY KEY (repo, commit_sha)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
""",
    # v2: a two-valued index on chunks.kind misled the planner (it scanned all
    # API chunks instead of using chunks_qualname or FTS).
    2: """
DROP INDEX IF EXISTS chunks_kind;
""",
}


def connect(path: Path | str, *, readonly: bool = False) -> sqlite3.Connection:
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 10000")
    if str(path) != ":memory:":
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
    if readonly:
        conn.execute("PRAGMA query_only = ON")
    return conn


def migrate(conn: sqlite3.Connection) -> None:
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    for version in sorted(_MIGRATIONS):
        if version <= current:
            continue
        log.info("migrating index schema to v%d", version)
        conn.executescript(_MIGRATIONS[version])
        conn.execute(f"PRAGMA user_version = {version}")
        conn.commit()


def open_db(path: Path | str) -> sqlite3.Connection:
    conn = connect(path)
    migrate(conn)
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.rollback()
        raise
    else:
        conn.commit()


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


class ConnectionPool:
    """One connection per thread; SQLite connections are not thread-safe to share."""

    def __init__(self, path: Path | str) -> None:
        self.path = path
        self._local = threading.local()
        self._all: list[sqlite3.Connection] = []
        self._lock = threading.Lock()
        conn = open_db(path)
        self._local.conn = conn
        self._all.append(conn)

    def get(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = connect(self.path)
            self._local.conn = conn
            with self._lock:
                self._all.append(conn)
        return conn

    def close(self) -> None:
        with self._lock:
            for conn in self._all:
                try:
                    conn.close()
                except sqlite3.Error:
                    pass
            self._all.clear()
