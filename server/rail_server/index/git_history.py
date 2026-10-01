"""Git history recovery of deleted functions (design plan §9.4, Phase 4).

For the last ``historyDepth`` commits, each modified or deleted Python file is
parsed before and after the commit. A function present before and absent after
becomes a ``code`` chunk with ``deleted = 1`` and ``commit_sha`` set to the
deleting commit. A function whose body reappears under another name in the
same commit is a rename, not a deletion. Blobs are read through one
``git cat-file --batch`` process rather than one process per file.
"""

from __future__ import annotations

import ast
import logging
import os
import sqlite3
import subprocess
from collections.abc import Callable
from typing import Any

from ..store.db import transaction
from .chunks import ChunkRow, insert_chunks, upsert_file
from .code import Root, chunk_source, excluded, module_name
from .embeddings import Embedder
from .pyast import norm_ws, safe_parse, sha1

log = logging.getLogger(__name__)

Progress = Callable[[str, int, int, str], None]


class CatFile:
    """A persistent ``git cat-file --batch`` reader."""

    def __init__(self, repo: str) -> None:
        self.proc = subprocess.Popen(
            ["git", "-C", repo, "cat-file", "--batch"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )

    def read(self, rev: str, path: str) -> str | None:
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write(f"{rev}:{path}\n".encode())
        self.proc.stdin.flush()
        header = self.proc.stdout.readline().decode("utf-8", errors="replace").split()
        if len(header) != 3 or header[1] != "blob":
            return None
        size = int(header[2])
        data = self.proc.stdout.read(size)
        self.proc.stdout.read(1)  # trailing newline
        return data.decode("utf-8", errors="replace")

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            self.proc.kill()


def _log(repo: str, depth: int) -> list[dict[str, Any]]:
    try:
        out = subprocess.run(
            [
                "git",
                "-C",
                repo,
                "log",
                f"-n{depth}",
                "--no-renames",
                "--name-status",
                "--format=%x00%H%x09%P%x09%aI",
                "--",
                "*.py",
            ],
            capture_output=True,
            timeout=120,
            check=False,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if out.returncode != 0:
        return []
    commits = []
    for block in out.stdout.decode("utf-8", errors="replace").split("\0"):
        lines = [ln for ln in block.strip("\n").splitlines() if ln.strip()]
        if not lines:
            continue
        head = lines[0].split("\t")
        if len(head) != 3:
            continue
        sha, parents, date = head
        changes = []
        for ln in lines[1:]:
            parts = ln.split("\t")
            if len(parts) == 2 and parts[0] in ("M", "D"):
                changes.append((parts[0], parts[1]))
        commits.append({"sha": sha, "parents": parents.split(), "date": date, "changes": changes})
    return commits


def _functions(source: str | None) -> dict[str, tuple[str, str]]:
    """``qualname -> (normalized body without the def line, def name)``."""
    if not source:
        return {}
    tree = safe_parse(source)
    if tree is None:
        return {}
    lines = source.splitlines()
    out: dict[str, tuple[str, str]] = {}

    def visit(node: ast.AST, prefix: str) -> None:
        for child in getattr(node, "body", []):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                qual = f"{prefix}{child.name}"
                body = "\n".join(lines[child.lineno : child.end_lineno or child.lineno])
                out[qual] = (norm_ws(body), child.name)
                if isinstance(child, ast.ClassDef):
                    visit(child, qual + ".")

    visit(tree, "")
    return out


def index_history(
    conn: sqlite3.Connection,
    roots: list[Root],
    *,
    depth: int = 500,
    embedder: Embedder | None = None,
    progress: Progress | None = None,
    should_stop: Callable[[], bool] = lambda: False,
) -> dict[str, Any]:
    stats = {"commits": 0, "deleted_functions": 0, "renames_skipped": 0}
    repos = sorted({r.repo for r in roots if r.repo})
    for repo in repos:
        if should_stop():
            break
        done = {
            r[0]
            for r in conn.execute("SELECT commit_sha FROM indexed_history WHERE repo = ?", (repo,))
        }
        commits = [c for c in _log(repo, depth) if c["sha"] not in done]
        if not commits:
            continue
        live = {
            (r[0], r[1])
            for r in conn.execute(
                "SELECT rel_path, qualname FROM chunks WHERE repo = ? AND deleted = 0 "
                "AND kind = 'code'",
                (repo,),
            )
        }
        cat = CatFile(repo)
        try:
            for i, commit in enumerate(commits):
                if should_stop():
                    break
                if progress and i % 20 == 0:
                    progress("history", i, len(commits), os.path.basename(repo))
                rows: list[ChunkRow] = []
                if len(commit["parents"]) == 1:
                    rows = _deleted_in_commit(cat, repo, commit, live, stats)
                with transaction(conn):
                    for row in rows:
                        _ensure_file_row(conn, row.path, repo)
                    insert_chunks(conn, rows)
                    conn.execute(
                        "INSERT OR IGNORE INTO indexed_history(repo, commit_sha) VALUES (?, ?)",
                        (repo, commit["sha"]),
                    )
                stats["commits"] += 1
                stats["deleted_functions"] += len(rows)
        finally:
            cat.close()
    if progress:
        progress("history", 1, 1, "history indexed")
    return stats


def _deleted_in_commit(
    cat: CatFile,
    repo: str,
    commit: dict[str, Any],
    live: set[tuple[str, str]],
    stats: dict[str, int],
) -> list[ChunkRow]:
    sha, parent = commit["sha"], commit["parents"][0]
    afters: dict[str, dict[str, tuple[str, str]]] = {}
    befores: dict[str, str | None] = {}
    for status, rel in commit["changes"]:
        if excluded(rel):
            continue
        befores[rel] = cat.read(parent, rel)
        afters[rel] = _functions(cat.read(sha, rel) if status == "M" else None)
    after_bodies = {body for funcs in afters.values() for body, _ in funcs.values()}
    out: list[ChunkRow] = []
    for rel, before_src in befores.items():
        before = _functions(before_src)
        after = afters[rel]
        gone = [q for q in before if q not in after]
        if not gone or before_src is None:
            continue
        chunks = (
            chunk_source(
                os.path.join(repo, rel),
                before_src,
                rel_path=rel,
                repo=repo,
                commit_sha=sha,
                authored_at=commit["date"],
                deleted=True,
            )
            or []
        )
        module_prefix = module_name(rel) + "."
        by_local = {c.qualname[len(module_prefix) :]: c for c in chunks}
        for q in gone:
            body, _name = before[q]
            if body and body in after_bodies:
                stats["renames_skipped"] += 1
                continue
            chunk = by_local.get(q)
            if chunk is None or (rel, chunk.qualname) in live:
                continue
            # Only whole functions/classes that vanished; skip methods of a class
            # that vanished as a whole (the class chunk covers them).
            parent_q = q.rsplit(".", 1)[0] if "." in q else None
            if parent_q and parent_q in gone:
                continue
            out.append(chunk)
    return out


def _ensure_file_row(conn: sqlite3.Connection, path: str, repo: str) -> None:
    row = conn.execute("SELECT 1 FROM files WHERE path = ?", (path,)).fetchone()
    if row is None:
        upsert_file(conn, path, "history", sha1(path), repo=repo)
