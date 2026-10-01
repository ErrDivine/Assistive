"""The chunk row shared by every indexer, plus insert helpers."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from typing import Any

from .pyast import sha1

CHUNK_COLUMNS = (
    "kind",
    "qualname",
    "path",
    "start_line",
    "end_line",
    "signature",
    "docstring",
    "doc_sections",
    "raises_scan",
    "body",
    "dist_name",
    "dist_version",
    "repo",
    "commit_sha",
    "authored_at",
    "deleted",
    "is_private",
    "origin",
    "name_line",
    "doc_line",
    "rel_path",
    "chunk_hash",
)

BODY_MAX_LINES = 200


@dataclass
class ChunkRow:
    kind: str  # 'api' | 'code'
    qualname: str
    path: str
    start_line: int
    end_line: int
    name_line: int
    signature: str | None = None
    docstring: str | None = None
    doc_sections: dict[str, Any] | None = None
    raises_scan: list[dict[str, Any]] = field(default_factory=list)
    body: str | None = None
    dist_name: str | None = None
    dist_version: str | None = None
    repo: str | None = None
    commit_sha: str | None = None
    authored_at: str | None = None
    deleted: bool = False
    is_private: bool = False
    origin: str = "source"
    doc_line: int | None = None
    rel_path: str | None = None

    def content_hash(self) -> str:
        return sha1(
            "\x00".join(
                [self.qualname, self.signature or "", self.docstring or "", self.body or ""]
            )
        )

    def values(self) -> tuple[Any, ...]:
        return (
            self.kind,
            self.qualname,
            self.path,
            self.start_line,
            self.end_line,
            self.signature,
            self.docstring,
            json.dumps(self.doc_sections) if self.doc_sections else None,
            json.dumps(self.raises_scan) if self.raises_scan else None,
            self.body,
            self.dist_name,
            self.dist_version,
            self.repo,
            self.commit_sha,
            self.authored_at,
            int(self.deleted),
            int(self.is_private),
            self.origin,
            self.name_line,
            self.doc_line,
            self.rel_path,
            self.content_hash(),
        )


_INSERT = (
    f"INSERT INTO chunks ({', '.join(CHUNK_COLUMNS)}) "
    f"VALUES ({', '.join('?' for _ in CHUNK_COLUMNS)})"
)
_UPDATE = "UPDATE chunks SET " + ", ".join(f"{c} = ?" for c in CHUNK_COLUMNS) + " WHERE id = ?"


def insert_chunks(conn: sqlite3.Connection, rows: list[ChunkRow]) -> list[int]:
    ids = []
    for row in rows:
        cur = conn.execute(_INSERT, row.values())
        ids.append(int(cur.lastrowid or 0))
    return ids


def update_chunk(conn: sqlite3.Connection, chunk_id: int, row: ChunkRow) -> None:
    conn.execute(_UPDATE, (*row.values(), chunk_id))


def upsert_file(
    conn: sqlite3.Connection,
    path: str,
    source_kind: str,
    content_hash: str,
    *,
    dist_name: str | None = None,
    dist_version: str | None = None,
    repo: str | None = None,
    mtime: float | None = None,
    size: int | None = None,
) -> None:
    conn.execute(
        "INSERT INTO files(path, source_kind, dist_name, dist_version, repo, mtime, size, "
        "content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(path) DO UPDATE SET source_kind = excluded.source_kind, "
        "dist_name = excluded.dist_name, dist_version = excluded.dist_version, "
        "repo = excluded.repo, mtime = excluded.mtime, size = excluded.size, "
        "content_hash = excluded.content_hash",
        (path, source_kind, dist_name, dist_version, repo, mtime, size, content_hash),
    )


def truncate_body(lines: list[str]) -> str:
    return "\n".join(lines[:BODY_MAX_LINES])
