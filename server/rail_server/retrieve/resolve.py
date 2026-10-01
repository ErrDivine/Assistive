"""``resolve_api``: map an editor location or symbol to an indexed API chunk.

The fallback chain follows design plan §9.5:

1. exact span: the chunk whose lines contain the definition location;
2. stub path: a ``.pyi`` outside the index → module from the path + symbol;
3. hover text: a qualified name or ``(function) def name`` from the hover;
4. imports: the dotted expression at the cursor mapped through the file's imports.

Step 5 (DECISIONS.md D-007) infers builtin receiver types from local
annotations or literals (``d: dict`` / ``d = {}`` → ``builtins.dict.get``) so
the common case works even without a language server.
"""

from __future__ import annotations

import ast
import builtins
import os
import re
import threading
from collections import OrderedDict
from dataclasses import dataclass
from urllib.parse import unquote, urlparse

from ..index.pyast import DOTTED, IDENT, safe_parse, split_lines
from ..models import ContextFrame, SourceLoc
from .store import Row, Store, ident_at

BUILTIN_TYPES = {
    "dict": "dict",
    "Dict": "dict",
    "list": "list",
    "List": "list",
    "set": "set",
    "Set": "set",
    "frozenset": "frozenset",
    "FrozenSet": "frozenset",
    "str": "str",
    "bytes": "bytes",
    "bytearray": "bytearray",
    "int": "int",
    "float": "float",
    "tuple": "tuple",
    "Tuple": "tuple",
    "complex": "complex",
    "bool": "bool",
    "OrderedDict": None,
    "defaultdict": None,
}
_LITERAL_TYPES = [
    (re.compile(r"^\{\s*\}|^\{[^:{}]*:"), "dict"),
    (re.compile(r"^\{"), "set"),
    (re.compile(r"^\["), "list"),
    (re.compile(r"^[rRuU]?[fF]?['\"]"), "str"),
    (re.compile(r"^[bB][rR]?['\"]"), "bytes"),
    (re.compile(r"^\("), "tuple"),
    (re.compile(r"^(dict|list|set|str|bytes|tuple|frozenset|bytearray|int|float)\("), None),
]
_CODE_FENCE = re.compile(r"```[A-Za-z0-9_-]*\n(.*?)```", re.S)
_HOVER_KIND = re.compile(
    r"\((?:function|method|class|property|module|variable|type)\)\s+(?:def\s+|class\s+)?"
    r"([A-Za-z_][A-Za-z0-9_]*)"
)


@dataclass
class Resolution:
    row: Row
    display: str
    step: str  # exact_span | stub_path | hover | imports | local_type | diagnostic | explicit


def uri_to_path(uri: str) -> str | None:
    if uri.startswith("file:"):
        parsed = urlparse(uri)
        path = unquote(parsed.path)
        if os.name == "nt" and re.match(r"^/[A-Za-z]:", path):
            path = path[1:]
        return path
    if uri.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", uri):
        return uri
    return None


class _ImportCache:
    def __init__(self) -> None:
        self._data: OrderedDict[str, tuple[float, dict[str, str]]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, path: str) -> dict[str, str]:
        try:
            mtime = os.stat(path).st_mtime
        except OSError:
            return {}
        with self._lock:
            hit = self._data.get(path)
            if hit and hit[0] == mtime:
                return hit[1]
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            return {}
        imports = parse_imports(text)
        with self._lock:
            self._data[path] = (mtime, imports)
            while len(self._data) > 128:
                self._data.popitem(last=False)
        return imports


_IMPORT_LINE = re.compile(r"^\s*(?:from\s+[\w.]+\s+import\s+.+|import\s+.+)$")


def parse_imports(text: str) -> dict[str, str]:
    """Local name → qualified name for every absolute import in ``text``."""
    tree = safe_parse(text)
    if tree is None:
        # Unsaved or broken file: parse the import lines alone.
        lines = [ln.strip() for ln in text.splitlines() if _IMPORT_LINE.match(ln)]
        tree = safe_parse("\n".join(ln for ln in lines if not ln.endswith(("(", "\\"))))
        if tree is None:
            return {}
    out: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.asname:
                    out[a.asname] = a.name
                else:
                    head = a.name.split(".")[0]
                    out.setdefault(head, head)
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            for a in node.names:
                if a.name == "*":
                    continue
                out[a.asname or a.name] = f"{node.module}.{a.name}"
    return out


_imports = _ImportCache()


def cursor_line(frame: ContextFrame, store: Store) -> str | None:
    """The cursor's line, preferring the live buffer text sent in the frame."""
    if frame.enclosing_text and frame.enclosing_range is not None:
        idx = frame.cursor.line - frame.enclosing_range.start_line
        lines = split_lines(frame.enclosing_text)
        if 0 <= idx < len(lines):
            return lines[idx]
    path = uri_to_path(frame.doc_uri)
    if path:
        file_lines = store.lines.lines(path)
        if file_lines and 0 <= frame.cursor.line < len(file_lines):
            return file_lines[frame.cursor.line]
    return None


def expression_at(line: str, character: int) -> str | None:
    """Dotted expression ending at the identifier under ``character``.

    ``resp = requests.get(url)`` with the cursor on ``get`` → ``requests.get``.
    Returns None when the receiver is not a plain name chain (``f().get``).
    """
    for m in IDENT.finditer(line):
        if m.start() <= character <= m.end():
            start, end = m.start(), m.end()
            break
    else:
        return None
    while start > 0 and line[start - 1] == ".":
        j = start - 1
        k = j
        while k > 0 and (line[k - 1].isalnum() or line[k - 1] == "_"):
            k -= 1
        if k == j:
            # A literal receiver: "sep".join(...) / b"x".split(...)
            if j > 0 and line[j - 1] in "'\"":
                q = line[j - 1]
                opening = line.rfind(q, 0, j - 1)
                prefix = line[max(0, opening - 2) : opening].lower() if opening >= 0 else ""
                kind = "bytes" if "b" in prefix else "str"
                return f"<{kind}>.{line[m.start() : end]}"
            return "?" + line[m.start() : end]
        if not IDENT.fullmatch(line[k:j]):
            return None
        start = k
    expr = line[start:end]
    return expr if IDENT.match(expr) else None


def imports_for(frame: ContextFrame) -> dict[str, str]:
    path = uri_to_path(frame.doc_uri)
    imports = dict(_imports.get(path)) if path else {}
    if frame.enclosing_text:
        imports.update(
            parse_imports(
                "\n".join(ln for ln in frame.enclosing_text.splitlines() if _IMPORT_LINE.match(ln))
            )
        )
    return imports


class Resolver:
    def __init__(self, store: Store) -> None:
        self.store = store
        self._stub_cache: OrderedDict[str, tuple[float, ast.Module | None]] = OrderedDict()

    # -- helpers ----------------------------------------------------------
    def _display(self, row: Row, fallback: str | None = None) -> str:
        if fallback:
            return fallback
        qual = str(row["qualname"])
        if row["origin"] == "runtime_doc" and qual.startswith("builtins."):
            return qual[len("builtins.") :]
        alias = self.store.conn.execute(
            "SELECT alias FROM aliases WHERE target = ? ORDER BY length(alias) LIMIT 1", (qual,)
        ).fetchone()
        if alias and len(alias[0]) < len(qual):
            return str(alias[0])
        return qual

    def _accept_span_hit(self, row: Row, loc: SourceLoc, symbol: str | None) -> bool:
        short = str(row["qualname"]).split(".")[-1]
        if symbol and short == symbol:
            return True
        lines = self.store.lines.lines(loc.path)
        if lines and 0 <= loc.line < len(lines):
            ident = ident_at(lines[loc.line], loc.character)
            if ident == short:
                return True
        if loc.line == 0 and row["start_line"] == 1 and row["signature"] is None:
            return True  # a module: definitions of modules point at (0, 0)
        return row["name_line"] == loc.line + 1 and symbol is None

    def _stub_tree(self, path: str) -> ast.Module | None:
        try:
            mtime = os.stat(path).st_mtime
        except OSError:
            return None
        hit = self._stub_cache.get(path)
        if hit and hit[0] == mtime:
            return hit[1]
        lines = self.store.lines.lines(path)
        tree = safe_parse("\n".join(lines), path) if lines is not None else None
        self._stub_cache[path] = (mtime, tree)
        while len(self._stub_cache) > 64:
            self._stub_cache.popitem(last=False)
        return tree

    # -- step 1 -----------------------------------------------------------
    def exact_span(
        self, loc: SourceLoc, symbol: str | None, frame: ContextFrame | None
    ) -> Resolution | None:
        doc_path = uri_to_path(frame.doc_uri) if frame else None
        for row in self.store.by_span(loc.path, loc.line + 1):
            if row["kind"] == "code" and doc_path and _same_file(row["path"], doc_path):
                c = frame.cursor.line + 1 if frame else -1
                if row["start_line"] <= c <= row["end_line"]:
                    continue  # the code being edited is not a reference (exclude_self)
            if self._accept_span_hit(row, loc, symbol):
                return Resolution(row, self._display(row), "exact_span")
        return None

    # -- step 2 -----------------------------------------------------------
    def stub_path(self, loc: SourceLoc, symbol: str | None) -> Resolution | None:
        if not loc.path.endswith(".pyi"):
            return None
        parts = os.path.normpath(loc.path)[: -len(".pyi")].split(os.sep)
        if parts and parts[-1] == "__init__":
            parts = parts[:-1]
        parts = [p for p in parts if p]
        module = None
        for k in range(max(0, len(parts) - 6), len(parts)):
            candidate = ".".join(parts[k:])
            if all(IDENT.fullmatch(p) for p in parts[k:]) and self.store.module_exists(candidate):
                module = candidate
                break
        if module is None:
            return None
        lines = self.store.lines.lines(loc.path) or []
        name = None
        if 0 <= loc.line < len(lines):
            name = ident_at(lines[loc.line], loc.character)
        name = name or symbol
        if not name:
            return None
        classes: list[str] = []
        tree = self._stub_tree(loc.path)
        if tree is not None:
            line1 = loc.line + 1
            node: ast.AST = tree
            while True:
                inner = None
                for child in getattr(node, "body", []):
                    if isinstance(child, ast.ClassDef) and child.lineno <= line1 <= (
                        child.end_lineno or child.lineno
                    ):
                        inner = child
                        break
                if inner is None:
                    break
                classes.append(inner.name)
                node = inner
        if classes and classes[-1] == name:
            classes = classes[:-1]
        qual = ".".join([module, *classes, name])
        row = self.store.lookup(qual)
        if row is None:
            return None
        display = ".".join([*classes, name]) if module == "builtins" else qual
        return Resolution(row, display, "stub_path")

    # -- step 3 -----------------------------------------------------------
    def hover(
        self, hover_text: str, frame: ContextFrame, symbol: str | None = None
    ) -> Resolution | None:
        # Only the code part of the hover names the symbol; the prose after it
        # mentions other APIs ("like time.strptime()").
        blocks = _CODE_FENCE.findall(hover_text)
        code = "\n".join(blocks) if blocks else hover_text.split("\n---", 1)[0]
        names = sorted(set(DOTTED.findall(code)), key=len, reverse=True)
        for name in names[:8]:
            if symbol and name.split(".")[-1] != symbol:
                continue
            row = self.store.lookup(name)
            if row is not None:
                return Resolution(row, name, "hover")
        m = _HOVER_KIND.search(code)
        if not m:
            return None
        ident = m.group(1)
        prefixes = sorted({q.split(".")[0] for q in imports_for(frame).values()})
        if not prefixes:
            return None
        rows = self.store.by_suffix(ident, prefixes)
        distinct = {r["qualname"] for r in rows if not r["is_private"]}
        if len(distinct) == 1:
            row = next(r for r in rows if r["qualname"] in distinct)
            return Resolution(row, self._display(row), "hover")
        return None

    # -- step 4 -----------------------------------------------------------
    def imports(self, expr: str, frame: ContextFrame) -> Resolution | None:
        if not expr or expr.startswith("?"):
            return None
        parts = expr.split(".")
        imports = imports_for(frame)
        head = parts[0]
        if head in imports:
            qual = ".".join([imports[head], *parts[1:]])
            row = self.store.lookup(qual)
            if row is not None:
                return Resolution(row, expr, "imports")
            return None
        if hasattr(builtins, head) and not _locally_bound(head, frame):
            row = self.store.lookup("builtins." + expr)
            if row is not None:
                return Resolution(row, expr, "imports")
        return None

    # -- step 5 -----------------------------------------------------------
    def local_type(self, expr: str, frame: ContextFrame) -> Resolution | None:
        """``var.attr`` where ``var``'s type is evident from the code around it:
        an annotation (``d: dict``), a literal (``d = {}``), a constructor call
        (``window = deque(maxlen=3)``, ``s = requests.Session()``) or a string
        literal receiver (``", ".join``)."""
        if not expr or "." not in expr or expr.startswith("?"):
            return None
        var, attr = expr.rsplit(".", 1)
        if var.startswith("<") and var.endswith(">"):
            row = self.store.lookup(f"builtins.{var[1:-1]}.{attr}")
            return Resolution(row, f"{var[1:-1]}.{attr}", "local_type") if row else None
        if "." in var:
            return None
        text = frame.enclosing_text or ""
        typ = infer_builtin_type(var, text)
        if typ is not None:
            row = self.store.lookup(f"builtins.{typ}.{attr}")
            if row is not None:
                return Resolution(row, f"{typ}.{attr}", "local_type")
        ctor = infer_constructor(var, text)
        if ctor is None:
            return None
        imports = imports_for(frame)
        head, _, rest = ctor.partition(".")
        if head in imports:
            cls = ".".join(p for p in (imports[head], rest) if p)
        elif hasattr(builtins, head) and not rest:
            cls = f"builtins.{head}"
        else:
            return None
        row = self.store.lookup(f"{cls}.{attr}")
        if row is None:
            return None
        return Resolution(row, f"{ctor.split('.')[-1]}.{attr}", "local_type")

    # -- entry points -----------------------------------------------------
    def resolve_loc(
        self, loc: SourceLoc, symbol: str | None = None, frame: ContextFrame | None = None
    ) -> Resolution | None:
        return self.exact_span(loc, symbol, frame) or self.stub_path(loc, symbol)

    def resolve_cursor(self, frame: ContextFrame) -> Resolution | None:
        sym = frame.symbol_at_cursor
        if sym is None:
            return None
        if sym.definition is not None:
            res = self.resolve_loc(sym.definition, sym.text, frame)
            if res:
                return res
            if _same_file(sym.definition.path, uri_to_path(frame.doc_uri) or ""):
                # Defined in this very file (a local name): nothing to look up.
                return None
        if sym.hover_text:
            res = self.hover(sym.hover_text, frame, sym.text)
            if res:
                return res
        line = cursor_line(frame, self.store)
        expr = expression_at(line, frame.cursor.character) if line else None
        if expr and expr.split(".")[-1] != sym.text and not expr.startswith("?"):
            expr = None
        if not expr:
            return None
        return self.imports(expr, frame) or self.local_type(expr, frame)

    def lookup_name(self, name: str, frame: ContextFrame) -> Resolution | None:
        """Resolve a bare or dotted identifier (diagnostics, explicit questions)."""
        res = self.imports(name, frame)
        if res:
            return res
        row = self.store.lookup(name) if "." in name else None
        if row is not None:
            return Resolution(row, name, "imports")
        prefixes = sorted({q.split(".")[0] for q in imports_for(frame).values()})
        if not prefixes:
            return None
        rows = self.store.by_suffix(name, prefixes)
        distinct = {r["qualname"] for r in rows if not r["is_private"]}
        if len(distinct) == 1:
            row = next(r for r in rows if r["qualname"] in distinct)
            return Resolution(row, self._display(row), "suffix")
        return None


def _same_file(a: str, b: str) -> bool:
    if not a or not b:
        return False
    if a == b:
        return True
    try:
        return os.path.realpath(a) == os.path.realpath(b)
    except OSError:
        return False


def _locally_bound(name: str, frame: ContextFrame) -> bool:
    text = frame.enclosing_text or ""
    return (
        re.search(rf"(?m)^\s*(?:def|class)\s+{re.escape(name)}\b|\b{re.escape(name)}\s*=[^=]", text)
        is not None
    )


def infer_constructor(var: str, text: str) -> str | None:
    """The class ``var`` was built from: ``var = Name(...)`` / ``var: Name``,
    where Name is a capitalized or dotted (``requests.Session``) callable or
    one of the common lowercase stdlib classes."""
    v = re.escape(var)
    lower_ok = {"deque", "defaultdict", "partial", "datetime", "date", "timedelta"}
    for assign in re.finditer(
        rf"(?m)(?<![.\w]){v}\s*(?::\s*[^=\n]+)?=(?!=)\s*([A-Za-z_][\w.]*)\s*\(", text
    ):
        name = assign.group(1)
        last = name.split(".")[-1]
        if last[:1].isupper() or last in lower_ok:
            return name
    m = re.search(rf"(?<![.\w]){v}\s*:\s*([A-Za-z_][\w.]*)", text)
    if m:
        name = m.group(1)
        last = name.split(".")[-1]
        if (last[:1].isupper() or last in lower_ok) and last not in BUILTIN_TYPES:
            return name
    return None


def infer_builtin_type(var: str, text: str) -> str | None:
    """``var``'s builtin type from an annotation or literal assignment in ``text``."""
    v = re.escape(var)
    m = re.search(rf"\b{v}\s*:\s*([A-Za-z_][A-Za-z0-9_]*)", text)
    if m:
        typ = BUILTIN_TYPES.get(m.group(1))
        if typ:
            return typ
    for m in re.finditer(rf"(?m)(?<![.\w]){v}\s*=(?!=)\s*(.+)$", text):
        rhs = m.group(1).strip()
        for pattern, typ in _LITERAL_TYPES:
            pm = pattern.match(rhs)
            if pm:
                return typ or pm.group(1)
    return None
