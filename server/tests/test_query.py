"""Query-level behaviour on the fixture index: precedent self-exclusion, file
saves, stale requests, history recovery (design plan Phases 2-4)."""

from __future__ import annotations

import asyncio
import json
import shutil
import time
from pathlib import Path

from conftest import FIXTURE_APP, FIXTURES, frame, needs_fixtures

from rail_server.models import ContextFrame

pytestmark = needs_fixtures


def _func_text(path: Path, name: str) -> tuple[str, int, int]:
    import ast

    src = path.read_text()
    node = next(
        n for n in ast.walk(ast.parse(src)) if isinstance(n, ast.FunctionDef) and n.name == name
    )
    lines = src.splitlines()
    return "\n".join(lines[node.lineno - 1 : node.end_lineno]), node.lineno - 1, node.end_lineno - 1


def test_editing_a_function_never_shows_itself(indexed_server) -> None:  # type: ignore[no-untyped-def]
    conn = indexed_server.pool.get()
    rows = conn.execute(
        "SELECT qualname, path FROM chunks WHERE kind = 'code' AND deleted = 0 "
        "AND qualname NOT LIKE '%.%.%.%'"
    ).fetchall()
    checked = 0
    for qualname, path in rows:
        name = qualname.split(".")[-1]
        try:
            text, start, end = _func_text(Path(path), name)
        except StopIteration:
            continue
        f = ContextFrame.model_validate(
            frame(
                requestId=1000 + checked,
                trigger="edit_pause",
                docUri=Path(path).as_uri(),
                cursor={"line": end, "character": 4},
                enclosingText=text,
                enclosingRange={"startLine": start, "endLine": end},
            )
        )
        cards = indexed_server.query_sync(f)
        assert all(c.qualname != qualname for c in cards if c.kind == "precedent"), qualname
        checked += 1
    assert checked > 30


def test_saving_a_file_updates_its_chunks_within_2s(indexed_server, tmp_path) -> None:  # type: ignore[no-untyped-def]
    target = FIXTURE_APP / "app" / "rail_saved_module.py"
    try:
        target.write_text("def first_version():\n    return 1\n")
        t0 = time.monotonic()
        asyncio.run(indexed_server.file_changed({"path": str(target)}))
        conn = indexed_server.pool.get()
        quals = {
            r[0] for r in conn.execute("SELECT qualname FROM chunks WHERE path = ?", (str(target),))
        }
        assert quals == {"app.rail_saved_module.first_version"}
        target.write_text("def second_version():\n    return 2\n")
        asyncio.run(indexed_server.file_changed({"path": str(target)}))
        elapsed = time.monotonic() - t0
        quals = {
            r[0] for r in conn.execute("SELECT qualname FROM chunks WHERE path = ?", (str(target),))
        }
        assert quals == {"app.rail_saved_module.second_version"}
        assert elapsed < 2.0
        # The new chunk is embedded and searchable at once.
        cid = conn.execute("SELECT id FROM chunks WHERE path = ?", (str(target),)).fetchone()[0]
        assert indexed_server.vectors.scores(indexed_server._embedder.embed(["x"])[0], [cid])
    finally:
        target.unlink(missing_ok=True)
        asyncio.run(indexed_server.file_changed({"path": str(target)}))


def test_stale_requests_are_abandoned(indexed_server) -> None:  # type: ignore[no-untyped-def]
    path = FIXTURE_APP / "app" / "client.py"
    lines = path.read_text().splitlines()
    line = next(i for i, t in enumerate(lines) if "requests.get(" in t)
    col = lines[line].index("requests.get(") + 10

    async def burst() -> list[dict]:
        await asyncio.sleep(0)
        base = 5000
        tasks = [
            indexed_server.context_query(
                frame(
                    requestId=base + i,
                    docUri=path.as_uri(),
                    cursor={"line": line, "character": col},
                    symbolAtCursor={"text": "get"},
                )
            )
            for i in range(20)
        ]
        return list(await asyncio.gather(*tasks))

    indexed_server.latest_request_id = 0
    results = asyncio.run(burst())
    with_cards = [r for r in results if r["cards"]]
    assert [r["requestId"] for r in with_cards] == [5019]


def test_deleted_function_found_as_precedent_with_badge(indexed_server) -> None:  # type: ignore[no-untyped-def]
    manifest = json.loads((FIXTURES / "fixture_history.json").read_text())
    deleted = {d["qualname"]: d for d in manifest["deleted"]}
    query = '''def parse_tsv_line(line, sep="\\t"):
    """Split one TSV line, honouring double quotes."""
    fields, current, quoted = [], [], False
    for ch in line:
        if ch == '"':
            quoted = not quoted
        elif ch == sep and not quoted:
            fields.append("".join(current))
            current = []
        else:
            current.append(ch)
    fields.append("".join(current))
    return fields'''
    f = ContextFrame.model_validate(
        frame(
            requestId=9001,
            trigger="edit_pause",
            docUri=(FIXTURE_APP / "app" / "tsv.py").as_uri(),
            cursor={"line": 12, "character": 4},
            enclosingText=query,
            enclosingRange={"startLine": 0, "endLine": 12},
        )
    )
    cards = indexed_server.query_sync(f)
    hit = next(c for c in cards if c.qualname == "textutil.parse_csv_line")
    assert hit.kind == "precedent" and hit.source.deleted is True
    assert hit.source.commit == deleted["textutil.parse_csv_line"]["deleted_in"]
    assert hit.snippet and "quoted = not quoted" in hit.snippet.text
    # The rename is not reported as a deletion.
    conn = indexed_server.pool.get()
    names = {r[0] for r in conn.execute("SELECT qualname FROM chunks WHERE deleted = 1")}
    assert names == set(deleted)


def test_git_history_source_read(indexed_server) -> None:  # type: ignore[no-untyped-def]
    manifest = json.loads((FIXTURES / "fixture_history.json").read_text())
    d = manifest["deleted"][0]
    repo = str(FIXTURES / "fixture_history")
    res = asyncio.run(
        indexed_server.source_read(
            {
                "path": str(Path(repo) / d["path"]),
                "repo": repo,
                "commit": d["deleted_in"],
                "deleted": True,
            }
        )
    )
    assert "def " + d["qualname"].split(".")[-1] in res["text"]


def test_runtime_source_read(indexed_server) -> None:  # type: ignore[no-untyped-def]
    row = indexed_server.store.lookup("builtins.dict.get")
    res = asyncio.run(indexed_server.source_read({"path": row["path"]}))
    lines = res["text"].splitlines()
    assert lines[row["name_line"] - 1].startswith("get(")


_ = shutil
