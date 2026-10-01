"""Every resolve_api fallback step against the fixture index (design plan §9.5)."""

from __future__ import annotations

import ast
import tempfile
from pathlib import Path

import pytest
from conftest import STUBS, frame, needs_fixtures

from rail_server.models import ContextFrame, SourceLoc

pytestmark = needs_fixtures


def _def_loc(path: str, qualname: str) -> SourceLoc:
    tree = ast.parse(Path(path).read_text())
    node: ast.AST = tree
    for part in qualname.split("."):
        node = next(
            c
            for c in getattr(node, "body", [])
            if isinstance(c, (ast.FunctionDef, ast.ClassDef)) and c.name == part
        )
    line = node.lineno - 1  # type: ignore[attr-defined]
    col = Path(path).read_text().splitlines()[line].index(qualname.split(".")[-1])
    return SourceLoc(path=path, line=line, character=col)


def _site(probe: dict, module: str) -> str:
    for d in probe["dists"]:
        for p, m in zip(d["py_files"], d["modules"]):
            if m == module:
                return p
    raise KeyError(module)


_DOC = Path(tempfile.mkdtemp(prefix="rail-resolve-")) / "sample.py"


def _frame(line_text: str, col: int, sym: str, **kw: object) -> ContextFrame:
    text = (
        "import requests\nimport json\nfrom collections import deque\n\n\ndef f(url):\n" + line_text
    )
    _DOC.write_text(text)
    lines = text.splitlines()
    return ContextFrame.model_validate(
        frame(
            docUri=_DOC.as_uri(),
            cursor={"line": len(lines) - 1, "character": col},
            enclosingText="\n".join(lines[5:]) if "enclosing" not in kw else kw.pop("enclosing"),
            enclosingRange={"startLine": 5, "endLine": len(lines) - 1},
            symbolAtCursor={"text": sym, **kw},
        )
    )


def test_step1_exact_span(indexed_server, probe) -> None:  # type: ignore[no-untyped-def]
    loc = _def_loc(_site(probe, "requests.api"), "get")
    res = indexed_server.resolver.resolve_loc(loc, "get")
    assert res.row["qualname"] == "requests.api.get" and res.step == "exact_span"
    assert res.display == "requests.get"  # shortest re-export


def test_step1_rejects_non_matching_identifier(indexed_server, probe) -> None:  # type: ignore[no-untyped-def]
    loc = _def_loc(_site(probe, "requests.api"), "get")
    inside = SourceLoc(path=loc.path, line=loc.line + 5, character=4)  # a docstring line
    assert indexed_server.resolver.exact_span(inside, "something_else", None) is None


def test_step2_stub_path(indexed_server) -> None:  # type: ignore[no-untyped-def]
    loc = _def_loc(str(STUBS / "builtins.pyi"), "dict.get")
    res = indexed_server.resolver.resolve_loc(loc, "get")
    assert res.row["qualname"] == "builtins.dict.get" and res.step == "stub_path"
    assert res.row["origin"] == "runtime_doc"


def test_step3_hover_qualified_name(indexed_server) -> None:  # type: ignore[no-untyped-def]
    f = _frame(
        "    x = thing.get(url)", 14, "get", hoverText="```python\n(function) requests.api.get\n```"
    )
    res = indexed_server.resolver.resolve_cursor(f)
    assert res.row["qualname"] == "requests.api.get" and res.step == "hover"


def test_step4_imports(indexed_server) -> None:  # type: ignore[no-untyped-def]
    f = _frame("    r = requests.get(url)", 18, "get")
    res = indexed_server.resolver.resolve_cursor(f)
    assert res.row["qualname"] == "requests.api.get" and res.step == "imports"
    f = _frame("    return json.loads(url)", 17, "loads")
    assert indexed_server.resolver.resolve_cursor(f).row["qualname"] == "json.loads"


@pytest.mark.parametrize(
    ("line", "col", "sym", "qual"),
    [
        ("    d: dict = {}\n    d.get('a')", 6, "get", "builtins.dict.get"),
        (
            "    window = deque(maxlen=3)\n    window.append(1)",
            12,
            "append",
            "collections.deque.append",
        ),
        ("    s = requests.Session()\n    s.get(url)", 7, "get", "requests.sessions.Session.get"),
        ('    return ", ".join(url)', 18, "join", "builtins.str.join"),
    ],
)
def test_step5_local_types(indexed_server, line, col, sym, qual) -> None:  # type: ignore[no-untyped-def]
    f = _frame(line, col, sym)
    res = indexed_server.resolver.resolve_cursor(f)
    assert res is not None and res.row["qualname"] == qual


def test_unresolvable_returns_none(indexed_server) -> None:  # type: ignore[no-untyped-def]
    f = _frame("    value = url.strip_everything()", 6, "value")
    assert indexed_server.resolver.resolve_cursor(f) is None
