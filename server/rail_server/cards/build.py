"""Card builder (design plan §9.6). Every fact is verified (I3) before it ships."""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from typing import Any

from ..index.library import RUNTIME_DIST, STDLIB_DIST
from ..index.pyast import IDENT, norm_ws, read_text, sha1
from ..models import Card, Fact, RuntimeInfo, Snippet, SourceRef
from ..retrieve.store import Row, Store, is_runtime_path
from .verify import GitBlobCache, verify_fact

log = logging.getLogger(__name__)

MAX_PARAMS = 3
MAX_RAISES = 4
SNIPPET_LINES = 15


def card_id(kind: str, chunk_id: int) -> str:
    return sha1(f"{kind}:{chunk_id}")[:16]


def _param_names(signature: str | None) -> list[str]:
    if not signature or "(" not in signature:
        return []
    inner = signature[signature.index("(") + 1 :]
    depth = 0
    cur = ""
    parts: list[str] = []
    for ch in inner:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            if depth == 0:
                break
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    names = []
    for p in parts:
        m = re.match(r"\s*\*{0,2}([A-Za-z_][A-Za-z0-9_]*)", p)
        if m and m.group(1) not in ("self", "cls"):
            names.append(m.group(1))
    return names


def active_argument(text_before_cursor: str, short_name: str) -> str | int | None:
    """Which argument of a ``short_name(...)`` call the cursor is in.

    Returns the keyword name, the positional index, or None when the cursor is
    not inside a call to ``short_name``.
    """
    depth = 0
    i = len(text_before_cursor) - 1
    while i >= 0:
        ch = text_before_cursor[i]
        if ch in ")]}":
            depth += 1
        elif ch in "([{":
            if depth == 0:
                if ch != "(":
                    return None
                break
            depth -= 1
        i -= 1
    if i < 0:
        return None
    m = re.search(r"([A-Za-z_][A-Za-z0-9_]*)\s*$", text_before_cursor[:i])
    if not m or m.group(1) != short_name:
        return None
    args = text_before_cursor[i + 1 :]
    depth = 0
    index = 0
    current = ""
    for ch in args:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "," and depth == 0:
            index += 1
            current = ""
        else:
            current += ch
    kw = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)", current)
    return kw.group(1) if kw else index


class CardBuilder:
    def __init__(self, store: Store) -> None:
        self.store = store
        self.git = GitBlobCache()
        self._stale: set[tuple[str, str]] = set()
        self._lock = threading.Lock()
        self.dropped_facts = 0

    # -- span loading -----------------------------------------------------
    def load_lines(self, ref: SourceRef) -> list[str] | None:
        if ref.runtime is not None or is_runtime_path(ref.path):
            return self.store.runtime_lines(ref.path)
        if ref.deleted and ref.commit and ref.repo:
            rel = os.path.relpath(ref.path, ref.repo).replace(os.sep, "/")
            return self.git.lines(ref.repo, f"{ref.commit}^", rel)
        return self.store.lines.lines(ref.path)

    def source_ref(self, row: Row, start: int, end: int) -> SourceRef:
        runtime = None
        if row["origin"] == "runtime_doc":
            runtime = RuntimeInfo(python_version=row["dist_version"] or "")
        return SourceRef(
            path=row["path"],
            start_line=start,
            end_line=max(start, end),
            dist_name=row["dist_name"] or None,
            dist_version=row["dist_version"] or None,
            repo=row["repo"] or None,
            commit=row["commit_sha"] or None,
            deleted=bool(row["deleted"]) or None,
            runtime=runtime,
        )

    def _verified(self, facts: list[Fact]) -> list[Fact]:
        ok = [f for f in facts if verify_fact(f, self.load_lines)]
        self.dropped_facts += len(facts) - len(ok)
        return ok

    # -- staleness --------------------------------------------------------
    def is_stale(self, row: Row) -> bool:
        path = row["path"]
        if row["kind"] != "api" or is_runtime_path(path) or row["deleted"]:
            return False
        frow = self.store.file_row(path)
        if frow is None:
            return False
        try:
            st = os.stat(path)
        except OSError:
            stale = True
        else:
            if frow["mtime"] == st.st_mtime and frow["size"] == st.st_size:
                return False
            text = read_text(path)
            stale = text is None or sha1(text) != frow["content_hash"]
        if stale and frow["dist_name"]:
            with self._lock:
                self._stale.add((frow["dist_name"], frow["dist_version"]))
        return stale

    def drain_stale(self) -> set[tuple[str, str]]:
        with self._lock:
            out, self._stale = self._stale, set()
        return out

    # -- facts ------------------------------------------------------------
    def api_facts(self, row: Row, active: str | int | None = None) -> list[Fact]:
        runtime = row["origin"] == "runtime_doc"
        doc_origin = "runtime_doc" if runtime else "docstring"
        facts: list[Fact] = []
        name_line = int(row["name_line"] or row["start_line"])
        if row["signature"]:
            facts.append(
                Fact(
                    label="signature",
                    text=row["signature"],
                    origin="runtime_doc" if runtime else "signature",
                    span=self.source_ref(row, name_line, name_line),
                )
            )
        sections: dict[str, Any] = json.loads(row["doc_sections"]) if row["doc_sections"] else {}
        summary = sections.get("summary")
        if summary:
            facts.append(
                Fact(
                    label="summary",
                    text=summary["text"],
                    origin=doc_origin,
                    span=self.source_ref(row, summary["start"], summary["end"]),
                )
            )
        by_kind: dict[str, list[dict[str, Any]]] = {}
        for sec in sections.get("sections", []):
            by_kind.setdefault(sec["kind"], []).extend(sec["items"])
        returns = by_kind.get("returns") or by_kind.get("yields") or []
        if returns:
            item = returns[0]
            facts.append(
                Fact(
                    label="returns",
                    text=item["text"],
                    origin=doc_origin,
                    span=self.source_ref(row, item["start"], item["end"]),
                )
            )
        raised: set[str] = set()
        for item in by_kind.get("raises", [])[:MAX_RAISES]:
            raised.add(str(item.get("name") or "").split(".")[-1])
            facts.append(
                Fact(
                    label="raises",
                    text=item["text"],
                    origin=doc_origin,
                    span=self.source_ref(row, item["start"], item["end"]),
                )
            )
        scanned = json.loads(row["raises_scan"]) if row["raises_scan"] else []
        for item in scanned:
            exc = str(item["exc"]).split(".")[-1]
            if exc in raised or len(raised) >= MAX_RAISES or not item.get("text"):
                continue
            raised.add(exc)
            facts.append(
                Fact(
                    label="raises",
                    text=norm_ws(item["text"]),
                    origin="source_scan",
                    span=self.source_ref(row, item["line"], item["line"]),
                )
            )
        params = by_kind.get("parameters", []) + by_kind.get("other_parameters", [])
        if params:
            names = _param_names(row["signature"])
            want = None
            if isinstance(active, str):
                want = active
            elif isinstance(active, int) and active < len(names):
                want = names[active]
            if want:
                params = sorted(params, key=lambda it: 0 if _bare(it.get("name")) == want else 1)
            for item in params[:MAX_PARAMS]:
                facts.append(
                    Fact(
                        label="param",
                        text=item["text"],
                        origin=doc_origin,
                        span=self.source_ref(row, item["start"], item["end"]),
                    )
                )
        return facts

    # -- cards ------------------------------------------------------------
    def title(self, row: Row, display: str) -> str:
        dist, version = row["dist_name"], row["dist_version"]
        if dist == RUNTIME_DIST:
            return f"{display} · Python {version}"
        if dist == STDLIB_DIST:
            return f"{display} · stdlib {version}"
        if dist:
            return f"{display} · {dist} {version}"
        if row["repo"]:
            return f"{display} · {os.path.basename(row['repo'])}"
        return display

    def api_card(
        self,
        row: Row,
        *,
        confidence: float,
        reason: str,
        display: str | None = None,
        kind: str = "api",
        active: str | int | None = None,
    ) -> Card | None:
        facts = self._verified(self.api_facts(row, active))
        if not facts:
            return None
        name_line = int(row["name_line"] or row["start_line"])
        return Card(
            id=card_id(kind, int(row["id"])),
            kind=kind,  # type: ignore[arg-type]
            title=self.title(row, display or row["qualname"]),
            facts=facts,
            source=self.source_ref(row, name_line, int(row["end_line"])),
            confidence=round(max(0.0, min(1.0, confidence)), 3),
            reason=reason,
            qualname=row["qualname"],
            stale=self.is_stale(row) or None,
            authored_at=row["authored_at"] or None,
        )

    def precedent_card(
        self, row: Row, *, confidence: float, reason: str, query_text: str
    ) -> Card | None:
        ref = self.source_ref(row, int(row["start_line"]), int(row["end_line"]))
        lines = self.load_lines(ref)
        if not lines or int(row["end_line"]) > len(lines):
            return None
        start, end = int(row["start_line"]), int(row["end_line"])
        body = lines[start - 1 : end]
        s_off = _best_window(body, query_text, SNIPPET_LINES)
        snippet_lines = body[s_off : s_off + SNIPPET_LINES]
        snippet = Snippet(text="\n".join(snippet_lines), start_line=start + s_off)
        # The snippet is shown verbatim: check it against the span it came from.
        if (
            lines[snippet.start_line - 1 : snippet.start_line - 1 + len(snippet_lines)]
            != snippet_lines
        ):
            return None
        name_line = int(row["name_line"] or start)
        facts: list[Fact] = []
        def_line = lines[name_line - 1].strip() if name_line <= len(lines) else ""
        if def_line:
            facts.append(
                Fact(
                    label="signature",
                    text=row["signature"] or def_line,
                    origin="signature",
                    span=self.source_ref(row, name_line, name_line),
                )
            )
        sections = json.loads(row["doc_sections"]) if row["doc_sections"] else {}
        summary = sections.get("summary")
        if summary:
            facts.append(
                Fact(
                    label="summary",
                    text=summary["text"],
                    origin="docstring",
                    span=self.source_ref(row, summary["start"], summary["end"]),
                )
            )
        facts = self._verified(facts)
        if not facts:
            return None
        title = row["qualname"] or os.path.basename(row["path"])
        return Card(
            id=card_id("precedent", int(row["id"])),
            kind="precedent",
            title=self.title(row, title),
            facts=facts,
            snippet=snippet,
            source=self.source_ref(row, name_line, end),
            confidence=round(max(0.0, min(1.0, confidence)), 3),
            reason=reason,
            qualname=row["qualname"],
            authored_at=row["authored_at"] or None,
        )


def _bare(name: Any) -> str:
    return str(name or "").lstrip("*").lstrip("\\*").replace("\\", "").lstrip("*")


def _tokens(text: str) -> set[str]:
    out: set[str] = set()
    for m in IDENT.finditer(text):
        tok = m.group(0)
        out.add(tok.lower())
        for part in re.split(r"_|(?<=[a-z])(?=[A-Z])", tok):
            if len(part) > 2:
                out.add(part.lower())
    return out


def _best_window(body: list[str], query: str, size: int) -> int:
    """Offset of the ``size``-line window most similar to ``query``; 0 = head."""
    if len(body) <= size or not query:
        return 0
    q = _tokens(query)
    if not q:
        return 0
    scores = [len(_tokens(line) & q) for line in body]
    best, best_off = sum(scores[:size]), 0
    run = best
    for off in range(1, len(body) - size + 1):
        run += scores[off + size - 1] - scores[off - 1]
        if run > best:
            best, best_off = run, off
    head_score = sum(scores[:size])
    # Prefer the head unless another window is clearly more similar.
    return best_off if best >= head_score * 1.5 and best >= 3 else 0
