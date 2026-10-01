"""Workspace code indexer (design plan §9.4).

One ``code`` chunk per function, method and class (decorators included, body
truncated to 200 lines). Files come from ``git ls-files`` where possible,
otherwise a walk that honours ``.gitignore`` through ``pathspec``. Secrets and
environments are always excluded. Re-indexing a file keeps the id (and the
embedding) of every chunk whose text did not change.
"""

from __future__ import annotations

import ast
import logging
import os
import sqlite3
import subprocess
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import pathspec

from ..store.db import transaction
from .chunks import ChunkRow, insert_chunks, truncate_body, update_chunk, upsert_file
from .docparse import parse_sections
from .embeddings import Embedder, embedding_text, to_blob
from .pyast import decorated_start, is_private_name, read_text, safe_parse, scan_raises, sha1

log = logging.getLogger(__name__)

ALWAYS_EXCLUDE = [
    ".env*",
    "*secret*",
    "*.pem",
    "venv/",
    ".venv/",
    "node_modules/",
    "site-packages/",
    ".git/",
    "__pycache__/",
    ".tox/",
    ".nox/",
    ".mypy_cache/",
    ".pytest_cache/",
    "build/",
    "dist/",
    ".eggs/",
    "*.egg-info/",
]
_EXCLUDE_SPEC = pathspec.PathSpec.from_lines("gitwildmatch", ALWAYS_EXCLUDE)
MAX_FILE_BYTES = 1_000_000

Progress = Callable[[str, int, int, str], None]


def _git(args: list[str], cwd: str, timeout: float = 60) -> str | None:
    try:
        out = subprocess.run(
            ["git", *args], cwd=cwd, capture_output=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return out.stdout.decode("utf-8", errors="replace")


def repo_root(path: str) -> str | None:
    out = _git(["rev-parse", "--show-toplevel"], cwd=path)
    return os.path.realpath(out.strip()) if out and out.strip() else None


def excluded(rel_path: str) -> bool:
    return _EXCLUDE_SPEC.match_file(rel_path.replace(os.sep, "/"))


def list_python_files(root: str) -> list[str]:
    """Absolute paths of the Python files to index under ``root``."""
    root = os.path.realpath(root)
    out = _git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.py"], root)
    rels: list[str]
    if out is not None:
        rels = [r for r in out.split("\0") if r.endswith(".py")]
    else:
        rels = _walk_with_gitignore(root)
    files = []
    for rel in rels:
        if excluded(rel):
            continue
        path = os.path.join(root, rel)
        try:
            if os.path.isfile(path) and os.path.getsize(path) <= MAX_FILE_BYTES:
                files.append(path)
        except OSError:
            continue
    return sorted(files)


def _walk_with_gitignore(root: str) -> list[str]:
    specs: list[tuple[str, pathspec.PathSpec]] = []
    rels: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        rel_dir = "" if rel_dir == "." else rel_dir.replace(os.sep, "/")
        gi = os.path.join(dirpath, ".gitignore")
        if os.path.isfile(gi):
            try:
                with open(gi, encoding="utf-8", errors="replace") as fh:
                    specs.append((rel_dir, pathspec.PathSpec.from_lines("gitwildmatch", fh)))
            except OSError:
                pass

        def ignored(rel: str, is_dir: bool) -> bool:
            probe = rel + "/" if is_dir else rel
            if excluded(probe):
                return True
            for base, spec in specs:
                if base and not rel.startswith(base + "/"):
                    continue
                sub = rel[len(base) + 1 :] if base else rel
                if spec.match_file(sub + ("/" if is_dir else "")):
                    return True
            return False

        dirnames[:] = sorted(
            d for d in dirnames if not ignored(f"{rel_dir}/{d}" if rel_dir else d, True)
        )
        for name in sorted(filenames):
            if not name.endswith(".py"):
                continue
            rel = f"{rel_dir}/{name}" if rel_dir else name
            if not ignored(rel, False):
                rels.append(rel)
    return rels


def git_file_meta(root: str, max_commits: int = 5000) -> dict[str, tuple[str, str]]:
    """``rel_path -> (sha, authored_at)`` of the latest commit touching each file,
    from one ``git log`` pass (never one process per file)."""
    out = _git(
        ["log", f"-n{max_commits}", "--name-only", "--format=%x00%H%x09%aI", "--", "*.py"],
        root,
        timeout=120,
    )
    meta: dict[str, tuple[str, str]] = {}
    if not out:
        return meta
    for block in out.split("\0"):
        if not block.strip():
            continue
        lines = block.strip("\n").splitlines()
        head = lines[0].split("\t")
        if len(head) != 2:
            continue
        sha, date = head
        for rel in lines[1:]:
            rel = rel.strip()
            if rel and rel not in meta:
                meta[rel] = (sha, date)
    return meta


def module_name(rel_path: str) -> str:
    parts = rel_path.replace(os.sep, "/")[: -len(".py")].split("/")
    if parts[-1] == "__init__":
        parts = parts[:-1]
    # Drop a leading "src" layout directory.
    if len(parts) > 1 and parts[0] in ("src", "lib"):
        parts = parts[1:]
    return ".".join(p for p in parts if p) or "__main__"


def _signature(node: ast.AST) -> str:
    if isinstance(node, ast.ClassDef):
        bases = [ast.unparse(b) for b in node.bases] + [ast.unparse(k) for k in node.keywords]
        return f"{node.name}({', '.join(bases)})" if bases else node.name
    assert isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    sig = f"{node.name}({ast.unparse(node.args)})"
    if node.returns is not None:
        sig += f" -> {ast.unparse(node.returns)}"
    return sig


def _docstring(node: ast.AST) -> tuple[str | None, Any]:
    body = getattr(node, "body", None)
    if not body:
        return None, None
    first = body[0]
    if (
        isinstance(first, ast.Expr)
        and isinstance(first.value, ast.Constant)
        and isinstance(first.value.value, str)
    ):
        import griffe

        value = ast.get_docstring(node) or ""
        if not value:
            return None, None
        doc = griffe.Docstring(value, lineno=first.lineno, endlineno=first.end_lineno)
        return value, doc
    return None, None


def chunk_source(
    path: str,
    source: str,
    *,
    rel_path: str,
    repo: str | None,
    commit_sha: str | None = None,
    authored_at: str | None = None,
    deleted: bool = False,
) -> list[ChunkRow] | None:
    """Code chunks of one file, or None if it does not parse (never raises)."""
    tree = safe_parse(source, path)
    if tree is None:
        return None
    lines = source.splitlines()
    module = module_name(rel_path)
    rows: list[ChunkRow] = []

    def visit(node: ast.AST, prefix: str) -> None:
        for child in getattr(node, "body", []):
            if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            qual = f"{prefix}.{child.name}"
            start = decorated_start(child)
            end = int(child.end_lineno or child.lineno)
            value, doc = _docstring(child)
            try:
                sections = parse_sections(doc, lines) if doc is not None else None
            except Exception:
                sections = None
            is_fn = not isinstance(child, ast.ClassDef)
            rows.append(
                ChunkRow(
                    kind="code",
                    qualname=qual,
                    path=path,
                    start_line=start,
                    end_line=end,
                    name_line=child.lineno,
                    signature=_signature(child),
                    docstring=value,
                    doc_sections=sections,
                    raises_scan=scan_raises(child, lines) if is_fn else [],
                    body=truncate_body(lines[start - 1 : end]),
                    repo=repo,
                    commit_sha=commit_sha,
                    authored_at=authored_at,
                    deleted=deleted,
                    is_private=is_private_name(child.name),
                    doc_line=doc.lineno if doc is not None else None,
                    rel_path=rel_path,
                )
            )
            if isinstance(child, ast.ClassDef):
                visit(child, qual)

    try:
        visit(tree, module)
    except RecursionError:
        return None
    return rows


@dataclass
class FileResult:
    path: str
    status: str  # unchanged | updated | removed | unparsable | missing
    inserted: list[int]
    kept: int = 0
    removed: int = 0


def _iso_mtime(path: str) -> str | None:
    try:
        return datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).isoformat(
            timespec="seconds"
        )
    except OSError:
        return None


def index_file(
    conn: sqlite3.Connection,
    path: str,
    *,
    root: str,
    repo: str | None,
    meta: dict[str, tuple[str, str]] | None = None,
    force: bool = False,
) -> FileResult:
    """(Re-)chunk one file. Unchanged chunks keep their ids and embeddings."""
    rel = os.path.relpath(path, root)
    source = read_text(path) if os.path.isfile(path) else None
    if source is None:
        with transaction(conn):
            n = conn.execute(
                "SELECT COUNT(*) FROM chunks WHERE path = ? AND deleted = 0", (path,)
            ).fetchone()[0]
            conn.execute("DELETE FROM files WHERE path = ? AND source_kind = 'workspace'", (path,))
        return FileResult(path, "missing", [], removed=n)
    digest = sha1(source)
    frow = conn.execute("SELECT content_hash FROM files WHERE path = ?", (path,)).fetchone()
    if frow is not None and frow[0] == digest and not force:
        return FileResult(path, "unchanged", [])
    sha, authored = (meta or {}).get(rel.replace(os.sep, "/"), (None, None))
    rows = chunk_source(
        path,
        source,
        rel_path=rel.replace(os.sep, "/"),
        repo=repo,
        commit_sha=sha,
        authored_at=authored or _iso_mtime(path),
    )
    if rows is None:
        log.info("skipping %s: syntax error", path)
        return FileResult(path, "unparsable", [])
    st = os.stat(path)
    with transaction(conn):
        old = conn.execute(
            "SELECT id, qualname, chunk_hash FROM chunks WHERE path = ? AND deleted = 0", (path,)
        ).fetchall()
        upsert_file(conn, path, "workspace", digest, repo=repo, mtime=st.st_mtime, size=st.st_size)
        by_key: dict[tuple[str, str], list[int]] = {}
        for r in old:
            by_key.setdefault((r[1], r[2]), []).append(int(r[0]))
        kept_ids: set[int] = set()
        fresh: list[ChunkRow] = []
        for row in rows:
            ids = by_key.get((row.qualname, row.content_hash()))
            if ids:
                cid = ids.pop(0)
                kept_ids.add(cid)
                update_chunk(conn, cid, row)  # lines may have moved
            else:
                fresh.append(row)
        stale = [int(r[0]) for r in old if int(r[0]) not in kept_ids]
        conn.executemany("DELETE FROM chunks WHERE id = ?", [(i,) for i in stale])
        inserted = insert_chunks(conn, fresh)
    return FileResult(path, "updated", inserted, kept=len(kept_ids), removed=len(stale))


@dataclass
class Root:
    path: str
    repo: str | None


def resolve_roots(paths: Iterable[str]) -> list[Root]:
    out: list[Root] = []
    seen: set[str] = set()
    for p in paths:
        if not p or not os.path.isdir(p):
            continue
        real = os.path.realpath(p)
        if real in seen:
            continue
        seen.add(real)
        out.append(Root(real, repo_root(real) or real))
    return out


def root_for(path: str, roots: list[Root]) -> Root | None:
    real = os.path.realpath(path)
    best = None
    for r in roots:
        if real == r.path or real.startswith(r.path.rstrip(os.sep) + os.sep):
            if best is None or len(r.path) > len(best.path):
                best = r
    return best


def index_roots(
    conn: sqlite3.Connection,
    roots: list[Root],
    *,
    progress: Progress | None = None,
    should_stop: Callable[[], bool] = lambda: False,
) -> dict[str, Any]:
    stats = {"files": 0, "updated": 0, "chunks_inserted": 0, "removed_files": 0}
    all_files: list[tuple[Root, str]] = []
    for root in roots:
        for f in list_python_files(root.path):
            all_files.append((root, f))
    metas = {root.path: git_file_meta(root.repo or root.path) for root in roots}
    total = len(all_files)
    for i, (root, path) in enumerate(all_files):
        if should_stop():
            break
        if progress and i % 25 == 0:
            progress("workspace", i, total, os.path.basename(path))
        base = root.repo or root.path
        res = index_file(conn, path, root=base, repo=root.repo, meta=metas.get(root.path))
        stats["files"] += 1
        if res.status == "updated":
            stats["updated"] += 1
            stats["chunks_inserted"] += len(res.inserted)
    # Forget workspace files that disappeared or are no longer listed.
    listed = {p for _, p in all_files}
    root_paths = [r.path for r in roots]
    gone = [
        r[0]
        for r in conn.execute("SELECT path FROM files WHERE source_kind = 'workspace'")
        if r[0] not in listed
        and any(r[0].startswith(rp.rstrip(os.sep) + os.sep) for rp in root_paths)
    ]
    if gone:
        with transaction(conn):
            conn.executemany("DELETE FROM files WHERE path = ?", [(p,) for p in gone])
        stats["removed_files"] = len(gone)
    if progress:
        progress("workspace", total, total, "workspace indexed")
    return stats


def embed_missing(
    conn: sqlite3.Connection,
    embedder: Embedder,
    *,
    progress: Progress | None = None,
    should_stop: Callable[[], bool] = lambda: False,
    batch: int = 64,
) -> int:
    """Embed every code chunk that lacks a vector from the current model."""
    conn.execute("DELETE FROM embeddings WHERE model != ?", (embedder.name,))
    conn.commit()
    todo = conn.execute(
        "SELECT c.id, c.qualname, c.signature, c.docstring, c.body FROM chunks c "
        "LEFT JOIN embeddings e ON e.chunk_id = c.id WHERE c.kind = 'code' AND e.chunk_id IS NULL "
        "ORDER BY c.id"
    ).fetchall()
    total = len(todo)
    done = 0
    for s in range(0, total, batch):
        if should_stop():
            break
        part = todo[s : s + batch]
        texts = [embedding_text(r[1], r[2], r[3], r[4]) for r in part]
        vecs = embedder.embed(texts)
        with transaction(conn):
            conn.executemany(
                "INSERT OR REPLACE INTO embeddings(chunk_id, model, dim, vec) "
                "SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM chunks WHERE id = ?)",
                [
                    (int(r[0]), embedder.name, int(vecs.shape[1]), to_blob(v), int(r[0]))
                    for r, v in zip(part, vecs)
                ],
            )
        done += len(part)
        if progress:
            progress("embeddings", done, total, f"{done}/{total} chunks")
    return done


def embed_ids(
    conn: sqlite3.Connection, embedder: Embedder, ids: list[int]
) -> tuple[list[int], Any]:
    """Embed specific chunks now (used on save); returns ids and vectors."""
    if not ids:
        return [], None
    marks = ",".join("?" for _ in ids)
    q = f"SELECT id, qualname, signature, docstring, body FROM chunks WHERE id IN ({marks})"
    rows = conn.execute(q, ids).fetchall()
    texts = [embedding_text(r[1], r[2], r[3], r[4]) for r in rows]
    vecs = embedder.embed(texts)
    with transaction(conn):
        conn.executemany(
            "INSERT OR REPLACE INTO embeddings(chunk_id, model, dim, vec) VALUES (?, ?, ?, ?)",
            [
                (int(r[0]), embedder.name, int(vecs.shape[1]), to_blob(v))
                for r, v in zip(rows, vecs)
            ],
        )
    return [int(r[0]) for r in rows], vecs


def path_under_roots(path: str, roots: list[Root]) -> bool:
    return root_for(path, roots) is not None and not excluded(
        os.path.relpath(os.path.realpath(path), root_for(path, roots).path)  # type: ignore[union-attr]
    )


__all__ = [
    "ALWAYS_EXCLUDE",
    "Root",
    "chunk_source",
    "embed_ids",
    "embed_missing",
    "excluded",
    "git_file_meta",
    "index_file",
    "index_roots",
    "list_python_files",
    "module_name",
    "path_under_roots",
    "repo_root",
    "resolve_roots",
    "root_for",
]
