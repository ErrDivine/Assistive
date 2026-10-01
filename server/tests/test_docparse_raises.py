"""Docstring section offsets and the raise scan (design plan §9.3, §13)."""

from __future__ import annotations

import ast
from pathlib import Path

from rail_server.index.library import extract_module
from rail_server.index.pyast import locate, norm_ws, scan_raises

GOOGLE = '''\
def f(url, timeout=3):
    """Fetch a URL.

    Longer description that spans
    two lines.

    Args:
        url: The address to
            fetch from.
        timeout (float): Seconds to wait.

    Returns:
        The decoded body.

    Raises:
        ValueError: If the URL is empty.
    """
    if not url:
        raise ValueError("empty")
    return url
'''

NUMPY = '''\
def g(x, y):
    """Add numbers.

    Parameters
    ----------
    x : int
        First operand.
    y : int
        Second operand.

    Returns
    -------
    int
        The sum.

    Raises
    ------
    TypeError
        When operands are not ints.
    """
    return x + y
'''

SPHINX = '''\
def h(path):
    """Read a file.

    :param path: Where the file lives.
    :returns: The file contents.
    :raises OSError: If the file cannot be read.
    """
    with open(path) as fh:
        return fh.read()
'''


def _row(src: str, name: str):  # type: ignore[no-untyped-def]
    rows, _ = extract_module("/tmp/m.py", "m", src, dist_name="d", dist_version="1")  # type: ignore[misc]
    return next(r for r in rows if r.qualname == f"m.{name}")


def _check_items_verbatim(src: str, sections: dict) -> None:
    lines = src.splitlines()
    for sec in sections["sections"]:
        for item in sec["items"]:
            span = norm_ws(" ".join(lines[item["start"] - 1 : item["end"]]))
            assert item["text"] in span, (item, span)
    summary = sections["summary"]
    span = norm_ws(" ".join(lines[summary["start"] - 1 : summary["end"]]))
    assert summary["text"] in span


def test_google_sections_with_line_offsets() -> None:
    row = _row(GOOGLE, "f")
    s = row.doc_sections
    assert s["style"] == "google"
    assert s["summary"] == {"text": "Fetch a URL.", "start": 2, "end": 2}
    kinds = {sec["kind"]: sec["items"] for sec in s["sections"]}
    url = kinds["parameters"][0]
    assert url["name"] == "url" and (url["start"], url["end"]) == (8, 9)
    assert url["text"] == "url: The address to fetch from."
    assert kinds["returns"][0]["text"] == "The decoded body." and kinds["returns"][0]["start"] == 13
    assert kinds["raises"][0]["text"] == "ValueError: If the URL is empty."
    _check_items_verbatim(GOOGLE, s)


def test_numpy_sections() -> None:
    s = _row(NUMPY, "g").doc_sections
    assert s["style"] == "numpy"
    kinds = {sec["kind"]: sec["items"] for sec in s["sections"]}
    assert kinds["parameters"][0]["text"] == "x : int First operand."
    assert (kinds["parameters"][0]["start"], kinds["parameters"][0]["end"]) == (6, 7)
    assert kinds["raises"][0]["text"] == "TypeError When operands are not ints."
    _check_items_verbatim(NUMPY, s)


def test_sphinx_sections() -> None:
    s = _row(SPHINX, "h").doc_sections
    assert s["style"] == "sphinx"
    kinds = {sec["kind"]: sec["items"] for sec in s["sections"]}
    assert kinds["parameters"][0]["text"] == "path: Where the file lives."
    assert kinds["raises"][0]["text"] == "OSError: If the file cannot be read."
    _check_items_verbatim(SPHINX, s)


def test_locate_minimal_window() -> None:
    lines = ["a b", "c d", "e f"]
    assert locate(lines, 10, "b c") == (10, 11)
    assert locate(lines, 10, "e") == (12, 12)
    assert locate(lines, 10, "zz") is None


RAISES = """\
def f(x):
    if x == 1:
        raise ValueError("one")
    if x == 2:
        raise errors.ConfigError
    try:
        pass
    except Exception as err:
        raise
    try:
        pass
    except Exception as err:
        raise err
    def inner():
        raise KeyError("nested scope is not f's")
    raise RuntimeError("x") from None
"""


def test_raise_scan() -> None:
    tree = ast.parse(RAISES)
    found = scan_raises(tree.body[0], RAISES.splitlines())
    assert [(r["exc"], r["line"]) for r in found] == [
        ("ValueError", 3),
        ("errors.ConfigError", 5),
        ("RuntimeError", 16),
    ]
    assert found[0]["text"] == 'raise ValueError("one")'


def test_raise_scan_in_index_marks_source_lines() -> None:
    row = _row(GOOGLE, "f")
    assert row.raises_scan == [
        {"exc": "ValueError", "line": 19, "text": 'raise ValueError("empty")'}
    ]


def test_private_and_test_files_flags(tmp_path: Path) -> None:
    src = "def _hidden():\n    pass\n\nclass A:\n    def __eq__(self, o):\n        return True\n"
    rows, _ = extract_module(str(tmp_path / "m.py"), "m", src)  # type: ignore[misc]
    flags = {r.qualname: r.is_private for r in rows}
    assert flags["m._hidden"] is True
    assert flags["m.A.__eq__"] is False
