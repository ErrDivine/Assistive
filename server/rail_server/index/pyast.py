"""Small AST and text helpers shared by the indexers and the card verifier."""

from __future__ import annotations

import ast
import hashlib
import re
from collections.abc import Iterator

_WS = re.compile(r"\s+")
IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
DOTTED = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+")


def norm_ws(text: str) -> str:
    """Collapse every whitespace run to one space (the I3 normalization)."""
    return _WS.sub(" ", text).strip()


def sha1(text: str | bytes) -> str:
    data = text.encode("utf-8", "surrogatepass") if isinstance(text, str) else text
    return hashlib.sha1(data).hexdigest()


def locate(lines: list[str], base_line: int, needle: str) -> tuple[int, int] | None:
    """Smallest window of ``lines`` whose normalized text contains ``needle``.

    ``base_line`` is the 1-based line number of ``lines[0]``. Returns absolute
    1-based inclusive line numbers.
    """
    target = norm_ws(needle)
    if not target:
        return None
    n = len(lines)
    end = None
    for j in range(n):
        if target in norm_ws(" ".join(lines[: j + 1])):
            end = j
            break
    if end is None:
        return None
    start = 0
    for i in range(end, -1, -1):
        if target in norm_ws(" ".join(lines[i : end + 1])):
            start = i
            break
    return base_line + start, base_line + end


def clip_words(text: str, limit: int = 400) -> str:
    """Prefix of ``text`` cut at a word boundary (stays a verbatim substring)."""
    if len(text) <= limit:
        return text
    cut = text.rfind(" ", 0, limit)
    return text[: cut if cut > limit // 2 else limit]


def _walk_own(node: ast.AST) -> Iterator[ast.AST]:
    """Walk ``node``'s body without descending into nested scopes."""
    stack = list(ast.iter_child_nodes(node))
    while stack:
        child = stack.pop()
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        yield child
        stack.extend(ast.iter_child_nodes(child))


def dotted_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted_name(node.value)
        return f"{base}.{node.attr}" if base else None
    return None


def scan_raises(func: ast.AST, lines: list[str]) -> list[dict[str, object]]:
    """Every ``raise X`` / ``raise X(...)`` in a function body (not nested defs).

    Bare re-raises are skipped, and so are ``raise err`` of a lowercase local.
    """
    found: list[dict[str, object]] = []
    for node in _walk_own(func):
        if not isinstance(node, ast.Raise) or node.exc is None:
            continue
        target = node.exc.func if isinstance(node.exc, ast.Call) else node.exc
        name = dotted_name(target)
        if not name or not name.split(".")[-1][:1].isupper():
            continue
        line = node.lineno
        text = lines[line - 1].strip() if 0 < line <= len(lines) else ""
        found.append({"exc": name, "line": line, "text": text})
    found.sort(key=lambda r: int(r["line"]))  # type: ignore[call-overload]
    return found


def def_nodes(tree: ast.AST) -> dict[int, ast.AST]:
    """Map the line of each ``def``/``class`` keyword to its node."""
    out: dict[int, ast.AST] = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out[node.lineno] = node
    return out


def header_end(node: ast.AST) -> int:
    """Last line of a def/class header (the line holding the colon)."""
    body = getattr(node, "body", None)
    lineno = int(getattr(node, "lineno", 1))
    if body:
        first = body[0]
        first_line = int(getattr(first, "lineno", lineno))
        if first_line > lineno:
            return first_line - 1
    return lineno


def decorated_start(node: ast.AST) -> int:
    lines = [int(getattr(d, "lineno", 10**9)) for d in getattr(node, "decorator_list", [])]
    return min([int(getattr(node, "lineno", 1)), *lines])


def is_private_name(qualname: str) -> bool:
    for part in qualname.split("."):
        if part.startswith("_") and not (part.startswith("__") and part.endswith("__")):
            return True
    return False


def safe_parse(source: str, filename: str = "<unknown>") -> ast.Module | None:
    try:
        return ast.parse(source, filename=filename)
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return None


def read_text(path: str) -> str | None:
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1")
