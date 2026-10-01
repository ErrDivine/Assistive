"""Library indexer (design plan §9.3).

Each file of a distribution is loaded statically with ``griffe.visit`` (no
imports, no inspection). Modules, classes, functions, methods and properties
become ``api`` chunks keyed by ``(dist_name, dist_version)``, so a version
indexed once serves every project that uses it. Each dist is committed in its
own transaction, which makes an interrupted sync resumable.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import time
from collections.abc import Callable, Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import griffe

from ..store.db import open_db, transaction
from .chunks import ChunkRow, insert_chunks, upsert_file
from .docparse import parse_sections, summary_of
from .pyast import (
    decorated_start,
    def_nodes,
    is_private_name,
    locate,
    read_text,
    safe_parse,
    scan_raises,
    sha1,
    split_lines,
)

log = logging.getLogger(__name__)
logging.getLogger("griffe").setLevel(logging.ERROR)

STDLIB_DIST = "stdlib"
RUNTIME_DIST = "python-runtime"
RUNTIME_SCHEME = "runtime:"

Progress = Callable[[str, int, int, str], None]


def _noop_progress(phase: str, done: int, total: int, message: str) -> None:
    return None


# -- per-file extraction ----------------------------------------------------


def _decorator_start(obj: Any) -> int:
    lines = [int(d.lineno) for d in getattr(obj, "decorators", []) or [] if d.lineno]
    return min([int(obj.lineno), *lines])


def _signature(obj: Any) -> str | None:
    try:
        if obj.is_function or obj.is_class:
            return str(obj.signature())
    except Exception:
        return None
    if obj.is_attribute and "property" in obj.labels:
        ann = obj.annotation
        return f"{obj.name}: {ann}" if ann is not None else f"{obj.name} (property)"
    return None


def extract_module(
    path: str,
    module: str,
    source: str,
    *,
    kind: str = "api",
    dist_name: str | None = None,
    dist_version: str | None = None,
) -> tuple[list[ChunkRow], list[tuple[str, str]]] | None:
    """Chunks and module-level aliases for one source file, or None if unparsable."""
    lines = split_lines(source)
    tree = safe_parse(source, path)
    if tree is None:
        return None
    try:
        mod = griffe.visit(module, Path(path), source)
    except Exception as e:  # griffe can choke on exotic syntax
        log.debug("griffe failed on %s: %s", path, e)
        return None
    defs = def_nodes(tree)
    rows: list[ChunkRow] = []
    aliases: list[tuple[str, str]] = []

    by_name: dict[str, list[Any]] = {}
    for node in defs.values():
        by_name.setdefault(node.name, []).append(node)  # type: ignore[attr-defined]

    def find_node(name: str, line: int) -> Any:
        # griffe reports the def line for some decorated functions and the
        # first decorator's line for others; the AST knows both.
        for node in by_name.get(name, []):
            if decorated_start(node) <= line <= node.lineno:
                return node
        return None

    def emit(obj: Any) -> None:
        reported = int(obj.lineno or 1)
        node = find_node(obj.name, reported)
        name_line = int(node.lineno) if node is not None else reported
        start_line = decorated_start(node) if node is not None else _decorator_start(obj)
        end_line = int(obj.endlineno or name_line)
        doc = obj.docstring
        raises = scan_raises(node, lines) if obj.is_function and node is not None else []
        rows.append(
            ChunkRow(
                kind=kind,
                qualname=obj.path,
                path=path,
                start_line=min(start_line, name_line),
                end_line=end_line,
                name_line=name_line,
                signature=_signature(obj),
                docstring=doc.value if doc else None,
                doc_sections=parse_sections(doc, lines, parent=obj) if doc else None,
                raises_scan=raises,
                dist_name=dist_name,
                dist_version=dist_version,
                is_private=is_private_name(obj.path),
                doc_line=int(doc.lineno) if doc and doc.lineno else None,
            )
        )

    def walk(obj: Any) -> None:
        for name, member in list(obj.members.items()):
            try:
                if member.is_alias:
                    if obj.is_module and not name.startswith("_"):
                        target = member.target_path
                        if target and target != member.path:
                            aliases.append((member.path, target))
                    continue
                if member.is_function or member.is_class:
                    emit(member)
                    if member.is_class:
                        walk(member)
                elif member.is_attribute and "property" in member.labels:
                    emit(member)
                elif member.is_attribute and obj.is_module and not name.startswith("_"):
                    # ``s = attributes = attrs``: a module-level name bound to
                    # another definition is an alias too.
                    value = member.value
                    target = getattr(value, "canonical_path", None)
                    if (
                        type(value).__name__ in ("ExprName", "ExprAttribute")
                        and target
                        and target != member.path
                    ):
                        aliases.append((member.path, str(target)))
            except Exception as e:  # one bad member must not lose the file
                log.debug("skipping %s.%s: %s", obj.path, name, e)

    # The module itself.
    mdoc = mod.docstring
    rows.append(
        ChunkRow(
            kind=kind,
            qualname=module,
            path=path,
            start_line=1,
            end_line=max(1, len(lines)),
            name_line=1,
            docstring=mdoc.value if mdoc else None,
            doc_sections=parse_sections(mdoc, lines, parent=mod) if mdoc else None,
            dist_name=dist_name,
            dist_version=dist_version,
            is_private=is_private_name(module),
            doc_line=int(mdoc.lineno) if mdoc and mdoc.lineno else None,
        )
    )
    walk(mod)
    aliases.extend(_wildcard_aliases(tree, module, path))
    return rows, aliases


def _wildcard_aliases(tree: Any, module: str, path: str) -> list[tuple[str, str]]:
    """``from X import *`` at module level → alias ``module.*`` → ``X``."""
    import ast

    out = []
    is_pkg = path.endswith("__init__.py")
    for node in getattr(tree, "body", []):
        if not isinstance(node, ast.ImportFrom) or not any(a.name == "*" for a in node.names):
            continue
        if node.level:
            base = module.split(".")
            base = base if is_pkg else base[:-1]
            base = base[: len(base) - (node.level - 1)] if node.level > 1 else base
            target = ".".join([*base, node.module] if node.module else base)
        else:
            target = node.module or ""
        if target:
            out.append((f"{module}.*", target))
    return out


# -- runtime-introspected builtins -----------------------------------------


def runtime_path(python_version: str, module: str) -> str:
    return f"{RUNTIME_SCHEME}{python_version}/{module}"


def render_runtime(
    entries: list[dict[str, Any]],
) -> tuple[list[str], list[tuple[int, int, int, int | None]]]:
    """Lay out introspected entries as a virtual document.

    Each entry becomes: its qualname, its signature (if any), its doc lines and
    a blank line. Returns the lines and, per entry, ``(start, end, sig_line,
    doc_line)`` (1-based). The same layout is used to serve ``source/read``.
    """
    out: list[str] = []
    spans: list[tuple[int, int, int, int | None]] = []
    for e in entries:
        start = len(out) + 1
        out.append(e["qualname"])
        sig_line = start
        if e.get("signature"):
            out.append(e["signature"])
            sig_line = len(out)
        doc_line = None
        doc = e.get("doc")
        if doc:
            doc_line = len(out) + 1
            out.extend(split_lines(doc))
        end = len(out)
        out.append("")
        spans.append((start, end, sig_line, doc_line))
    return out, spans


def runtime_rows(
    python_version: str, module: str, entries: list[dict[str, Any]]
) -> tuple[str, list[ChunkRow], str]:
    path = runtime_path(python_version, module)
    lines, spans = render_runtime(entries)
    rows = []
    for e, (start, end, sig_line, doc_line) in zip(entries, spans):
        doc = e.get("doc")
        sections: dict[str, Any] | None = None
        if doc and doc_line:
            summary = summary_of(doc)
            span = locate(lines[doc_line - 1 : end], doc_line, summary) if summary else None
            if span:
                sections = {
                    "style": None,
                    "summary": {"text": summary[:400], "start": span[0], "end": span[1]},
                    "sections": [],
                }
        rows.append(
            ChunkRow(
                kind="api",
                qualname=e["qualname"],
                path=path,
                start_line=start,
                end_line=end,
                name_line=sig_line,
                signature=e.get("signature"),
                docstring=doc,
                doc_sections=sections,
                dist_name=RUNTIME_DIST,
                dist_version=python_version,
                is_private=is_private_name(e["qualname"]),
                origin="runtime_doc",
                doc_line=doc_line,
            )
        )
    return path, rows, sha1("\n".join(lines))


# -- dist-level orchestration ----------------------------------------------


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def indexed_dists(conn: sqlite3.Connection) -> set[tuple[str, str]]:
    return {(r[0], r[1]) for r in conn.execute("SELECT dist_name, dist_version FROM indexed_dists")}


def index_dist(
    conn: sqlite3.Connection,
    name: str,
    version: str,
    py_files: list[str],
    modules: list[str],
) -> int:
    """Index one distribution in its own transaction. Returns the chunk count."""
    files: list[tuple[str, str, float, int]] = []
    all_rows: list[ChunkRow] = []
    all_aliases: list[tuple[str, str]] = []
    for path, module in zip(py_files, modules):
        source = read_text(path)
        if source is None:
            continue
        extracted = extract_module(path, module, source, dist_name=name, dist_version=version)
        if extracted is None:
            log.info("skipping unparsable %s", path)
            continue
        rows, aliases = extracted
        try:
            st = os.stat(path)
            mtime, size = st.st_mtime, st.st_size
        except OSError:
            mtime, size = 0.0, 0
        files.append((path, sha1(source), mtime, size))
        all_rows.extend(rows)
        all_aliases.extend(aliases)
    with transaction(conn):
        conn.executemany("DELETE FROM files WHERE path = ?", [(f[0],) for f in files])
        conn.execute(
            "DELETE FROM aliases WHERE dist_name = ? AND dist_version = ?", (name, version)
        )
        for path, digest, mtime, size in files:
            upsert_file(
                conn,
                path,
                "library",
                digest,
                dist_name=name,
                dist_version=version,
                mtime=mtime,
                size=size,
            )
        insert_chunks(conn, all_rows)
        conn.executemany(
            "INSERT OR REPLACE INTO aliases(alias, target, dist_name, dist_version) "
            "VALUES (?, ?, ?, ?)",
            [(a, t, name, version) for a, t in all_aliases],
        )
        conn.execute(
            "INSERT OR REPLACE INTO indexed_dists(dist_name, dist_version, indexed_at) "
            "VALUES (?, ?, ?)",
            (name, version, _now()),
        )
    return len(all_rows)


def index_runtime(
    conn: sqlite3.Connection, python_version: str, entries: list[dict[str, Any]]
) -> int:
    by_module: dict[str, list[dict[str, Any]]] = {}
    for e in entries:
        by_module.setdefault(e.get("module") or e["qualname"].split(".")[0], []).append(e)
    count = 0
    with transaction(conn):
        conn.execute(
            "DELETE FROM files WHERE dist_name = ? AND dist_version = ?",
            (RUNTIME_DIST, python_version),
        )
        for module, group in sorted(by_module.items()):
            path, rows, digest = runtime_rows(python_version, module, group)
            upsert_file(
                conn, path, "library", digest, dist_name=RUNTIME_DIST, dist_version=python_version
            )
            insert_chunks(conn, rows)
            count += len(rows)
        conn.execute(
            "INSERT OR REPLACE INTO indexed_dists(dist_name, dist_version, indexed_at) "
            "VALUES (?, ?, ?)",
            (RUNTIME_DIST, python_version, _now()),
        )
    return count


def _under(path: str, roots: Iterable[str]) -> bool:
    for root in roots:
        if root and (path == root or path.startswith(root.rstrip(os.sep) + os.sep)):
            return True
    return False


def active_dists(probe: dict[str, Any], *, include_stdlib: bool = True) -> list[tuple[str, str]]:
    """``(dist_name, dist_version)`` pairs visible from the probed environment."""
    pyver = probe["python_version"]
    out = [(d["name"], d["version"]) for d in probe.get("dists", [])]
    if include_stdlib:
        out.append((STDLIB_DIST, pyver))
    out.append((RUNTIME_DIST, pyver))
    return out


def sync_library(
    db_path: str,
    probe: dict[str, Any],
    *,
    workspace_roots: list[str] | None = None,
    index_stdlib: bool = True,
    progress: Progress = _noop_progress,
    should_stop: Callable[[], bool] = lambda: False,
) -> dict[str, Any]:
    """Index every dist in ``probe`` that is not yet in ``indexed_dists``."""
    conn = open_db(db_path)
    started = time.monotonic()
    try:
        done_set = indexed_dists(conn)
        pyver = probe["python_version"]
        roots = [os.path.abspath(r) for r in (workspace_roots or [])]
        todo: list[tuple[str, str, list[str], list[str]]] = []
        for d in probe.get("dists", []):
            if (d["name"], d["version"]) in done_set:
                continue
            pairs = [
                (p, m)
                for p, m in zip(d.get("py_files", []), d.get("modules", []))
                if not _under(p, roots)
            ]
            todo.append((d["name"], d["version"], [p for p, _ in pairs], [m for _, m in pairs]))
        std = probe.get("stdlib") or {}
        if index_stdlib and (STDLIB_DIST, pyver) not in done_set and std.get("py_files"):
            todo.append((STDLIB_DIST, pyver, std["py_files"], std["modules"]))
        need_runtime = (RUNTIME_DIST, pyver) not in done_set and probe.get("builtins")
        total = len(todo) + (1 if need_runtime else 0)
        chunks = 0
        done = 0
        if need_runtime:
            progress("library", done, total, "builtins")
            chunks += index_runtime(conn, pyver, probe["builtins"])
            done += 1
        for name, version, files, modules in todo:
            if should_stop():
                break
            progress("library", done, total, f"{name} {version}")
            try:
                chunks += index_dist(conn, name, version, files, modules)
            except sqlite3.Error:
                log.exception("indexing %s %s failed", name, version)
            done += 1
        progress("library", done, total, "libraries indexed")
        gc_library(conn)
        return {"dists": done, "chunks": chunks, "seconds": round(time.monotonic() - started, 2)}
    finally:
        conn.close()


def gc_library(conn: sqlite3.Connection) -> int:
    """Drop library files that vanished from disk; forget dists left empty."""
    gone = [
        r[0]
        for r in conn.execute("SELECT path FROM files WHERE source_kind = 'library'")
        if not r[0].startswith(RUNTIME_SCHEME) and not os.path.exists(r[0])
    ]
    if not gone:
        return 0
    with transaction(conn):
        conn.executemany("DELETE FROM files WHERE path = ?", [(p,) for p in gone])
        conn.execute(
            "DELETE FROM indexed_dists WHERE dist_name != ? AND NOT EXISTS (SELECT 1 FROM files f "
            "WHERE f.dist_name = indexed_dists.dist_name "
            "AND f.dist_version = indexed_dists.dist_version)",
            (RUNTIME_DIST,),
        )
    return len(gone)
