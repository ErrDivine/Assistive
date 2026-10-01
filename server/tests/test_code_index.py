"""Workspace code indexer: chunking, exclusions, incremental updates (design plan §9.4)."""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

from rail_server.index.code import (
    chunk_source,
    git_file_meta,
    index_file,
    list_python_files,
    resolve_roots,
)
from rail_server.store.db import open_db

SRC = '''\
import functools


@functools.lru_cache()
def cached(x):
    """Cache it."""
    return x


class Thing:
    def method(self):
        return 1

    async def amethod(self):
        return 2
'''


def test_chunks_include_decorators_and_methods() -> None:
    rows = chunk_source("/r/pkg/mod.py", SRC, rel_path="pkg/mod.py", repo="/r")
    assert rows is not None
    by = {r.qualname: r for r in rows}
    assert set(by) == {
        "pkg.mod.cached",
        "pkg.mod.Thing",
        "pkg.mod.Thing.method",
        "pkg.mod.Thing.amethod",
    }
    cached = by["pkg.mod.cached"]
    assert (cached.start_line, cached.name_line, cached.end_line) == (4, 5, 7)
    assert cached.body.startswith("@functools.lru_cache()")
    assert cached.signature == "cached(x)"
    assert cached.doc_sections and cached.doc_sections["summary"]["text"] == "Cache it."


def test_body_truncated_to_200_lines() -> None:
    src = "def big():\n" + "".join(f"    x{i} = {i}\n" for i in range(400))
    [row] = chunk_source("/r/big.py", src, rel_path="big.py", repo="/r") or []
    assert len(row.body.splitlines()) == 200
    assert row.end_line == 401


def test_syntax_error_is_skipped_not_raised() -> None:
    assert chunk_source("/r/bad.py", "def broken(:\n  pass", rel_path="bad.py", repo="/r") is None


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        env={
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@t",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@t",
            "PATH": "/usr/bin:/bin:/usr/local/bin",
            "HOME": str(cwd),
        },
    )


def test_file_list_excludes_secrets_envs_and_gitignored(tmp_path: Path) -> None:
    for rel in [
        "app/a.py",
        ".env.py",
        "my_secret_stuff.py",
        "venv/lib/x.py",
        ".venv/y.py",
        "node_modules/z.py",
        "lib/site-packages/s.py",
        "ignored/i.py",
        "keys.pem",
    ]:
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("x = 1\n")
    (tmp_path / ".gitignore").write_text("ignored/\n")
    # Without git: walk + pathspec.
    rels = sorted(str(Path(p).relative_to(tmp_path)) for p in list_python_files(str(tmp_path)))
    assert rels == ["app/a.py"]
    # With git ls-files.
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-qm", "init")
    rels = sorted(str(Path(p).relative_to(tmp_path)) for p in list_python_files(str(tmp_path)))
    assert rels == ["app/a.py"]


def test_git_meta_single_pass(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text("def a():\n    pass\n")
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-qm", "one")
    meta = git_file_meta(str(tmp_path))
    assert set(meta) == {"a.py"} and len(meta["a.py"][0]) == 40


def test_incremental_update_keeps_ids_and_is_fast(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    f = repo / "m.py"
    f.write_text("def keep():\n    return 1\n\n\ndef change():\n    return 2\n")
    conn = open_db(tmp_path / "db.sqlite")
    [root] = resolve_roots([str(repo)])
    res = index_file(conn, str(f), root=root.path, repo=root.repo)
    ids = {r[0]: r[1] for r in conn.execute("SELECT qualname, id FROM chunks")}
    assert res.status == "updated" and len(res.inserted) == 2
    # Unchanged content: nothing to do.
    assert index_file(conn, str(f), root=root.path, repo=root.repo).status == "unchanged"
    # Edit one function and shift the other: the untouched chunk keeps its id.
    f.write_text("# header\n\ndef keep():\n    return 1\n\n\ndef change():\n    return 3\n")
    t0 = time.monotonic()
    res = index_file(conn, str(f), root=root.path, repo=root.repo)
    assert time.monotonic() - t0 < 2.0
    after = {
        r[0]: (r[1], r[2]) for r in conn.execute("SELECT qualname, id, start_line FROM chunks")
    }
    assert after["m.keep"] == (ids["m.keep"], 3)
    assert after["m.change"][0] != ids["m.change"]
    assert res.kept == 1 and res.removed == 1 and len(res.inserted) == 1
    # Deleting the file removes its chunks.
    f.unlink()
    assert index_file(conn, str(f), root=root.path, repo=root.repo).status == "missing"
    assert conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] == 0
