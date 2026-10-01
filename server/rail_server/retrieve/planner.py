"""Query planner (design plan §9.5): candidates from exact API resolution,
diagnostics, explicit questions and precedent search."""

from __future__ import annotations

import keyword
import logging
import os
import re
import sqlite3
from collections.abc import Callable

from ..index.embeddings import Embedder
from ..index.pyast import DOTTED, IDENT, split_lines
from ..models import ContextFrame
from ..store.vectors import VectorIndex
from .ranker import Candidate, calibrate, rrf_fuse
from .resolve import Resolver, cursor_line, uri_to_path
from .store import Store

log = logging.getLogger(__name__)

CONF_CURSOR = 1.0
CONF_NEARBY = 0.8
CONF_DIAGNOSTIC = 0.7
CONF_EXPLICIT = 0.9
MIN_PRECEDENT_TEXT = 80
VECTOR_TOP_K = 20
FTS_TOP_K = 10
RRF_K = 60

_COMMON = frozenset(
    {
        "self",
        "cls",
        "None",
        "True",
        "False",
        "print",
        "len",
        "range",
        "str",
        "int",
        "dict",
        "list",
        "set",
        "tuple",
        "float",
        "bool",
        "object",
        "super",
        "isinstance",
        "return",
        "args",
        "kwargs",
        "value",
        "result",
        "data",
        "name",
        "item",
        "items",
        "key",
        "keys",
        "x",
        "y",
        "i",
        "j",
        "k",
        "n",
        "e",
        "f",
        "s",
        "obj",
        "the",
    }
)
# "name", 'name', `name`, and generic forms like "DictWriter[str]"
_QUOTED = re.compile(r"['\"`]([A-Za-z_][A-Za-z0-9_.]*)(?:\[[^'\"`]*\])?['\"`]")


def identifiers(text: str) -> list[str]:
    seen: dict[str, int] = {}
    for m in IDENT.finditer(text):
        tok = m.group(0)
        if len(tok) < 3 or tok in _COMMON or keyword.iskeyword(tok):
            continue
        seen[tok] = seen.get(tok, 0) + 1
    return list(seen)


def diagnostic_identifiers(messages: list[str]) -> list[str]:
    """Names mentioned in error messages: quoted names first, then dotted ones."""
    out: list[str] = []
    for msg in messages:
        for m in _QUOTED.finditer(msg):
            out.append(m.group(1))
        out.extend(DOTTED.findall(msg))
    return list(dict.fromkeys(n for n in out if n not in _COMMON))


def enclosing_def_name(text: str) -> str | None:
    m = re.search(r"^\s*(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)", text, re.M)
    return m.group(1) if m else None


def exclude_self(rows: list[sqlite3.Row], frame: ContextFrame) -> list[sqlite3.Row]:
    """Drop chunks that are the code being edited (same file, overlapping lines,
    or the enclosing def by name in the same file)."""
    doc = uri_to_path(frame.doc_uri)
    if not doc:
        return rows
    real_doc = os.path.realpath(doc)
    if frame.enclosing_range is not None:
        lo, hi = frame.enclosing_range.start_line + 1, frame.enclosing_range.end_line + 1
    else:
        lo = hi = frame.cursor.line + 1
    name = enclosing_def_name(frame.enclosing_text or "")
    out = []
    for r in rows:
        same_file = r["path"] == doc or os.path.realpath(r["path"]) == real_doc
        if same_file and not r["deleted"]:
            if r["start_line"] <= hi and r["end_line"] >= lo:
                continue
            if name and str(r["qualname"] or "").split(".")[-1] == name:
                continue
        out.append(r)
    return out


class PrecedentSearch:
    def __init__(
        self,
        store: Store,
        vectors: VectorIndex,
        embedder: Callable[[], Embedder | None],
        threshold: Callable[[], float],
    ) -> None:
        self.store = store
        self.vectors = vectors
        self.embedder = embedder
        self.threshold = threshold

    def query_text(self, frame: ContextFrame) -> str:
        edits = "\n".join(e.text for e in frame.recent_edits[-10:])
        extra = f"\n{frame.explicit_question}" if frame.explicit_question else ""
        return f"{frame.enclosing_text}\n{edits}{extra}"

    def fts(self, text: str, k: int = FTS_TOP_K) -> list[int]:
        idents = identifiers(text)[:40]
        if not idents:
            return []
        query = " OR ".join(f'"{t}"' for t in idents)
        try:
            rows = self.store.conn.execute(
                "SELECT f.rowid FROM chunks_fts f JOIN chunks c ON c.id = f.rowid "
                "WHERE chunks_fts MATCH ? AND c.kind = 'code' "
                "ORDER BY bm25(chunks_fts, 4.0, 2.0, 1.0, 1.0) LIMIT ?",
                (f"{{qualname signature docstring body}} : ({query})", k * 3),
            ).fetchall()
        except sqlite3.OperationalError as e:
            log.debug("fts query failed: %s", e)
            return []
        return [int(r[0]) for r in rows][: k * 3]

    def search(self, frame: ContextFrame, *, require_trigger: bool = True) -> list[Candidate]:
        if require_trigger and frame.trigger not in ("edit_pause", "explicit"):
            return []
        text = self.query_text(frame)
        if len((frame.enclosing_text or "").strip()) < MIN_PRECEDENT_TEXT and not (
            frame.trigger == "explicit" and frame.explicit_question
        ):
            return []
        embedder = self.embedder()
        if embedder is None or len(self.vectors) == 0:
            return []
        q_vec = embedder.embed([text])[0]
        vec_hits = self.vectors.search(q_vec, VECTOR_TOP_K)
        fts_hits = self.fts(text)
        fused = rrf_fuse([cid for cid, _ in vec_hits], fts_hits, k=RRF_K)
        ids = [cid for cid, _ in fused[: VECTOR_TOP_K + FTS_TOP_K]]
        rows_by_id = self.store.chunks(ids)
        rows = exclude_self([rows_by_id[i] for i in ids if i in rows_by_id], frame)
        cos = self.vectors.scores(q_vec, [int(r["id"]) for r in rows])
        fused_score = dict(fused)
        thr = self.threshold()
        out = []
        for r in rows:
            c = cos.get(int(r["id"]))
            if c is None or c < thr:
                continue
            reason = "Similar code you deleted" if r["deleted"] else "Similar code you wrote"
            out.append(
                Candidate(
                    row=r,
                    kind="precedent",
                    confidence=calibrate(c, thr),
                    reason=reason,
                    cosine=c,
                    fused=fused_score.get(int(r["id"]), 0.0),
                    extra={"query_text": text},
                )
            )
        return out

    def raw_scores(self, frame: ContextFrame) -> list[tuple[int, float]]:
        """Fused, self-excluded hits with their cosine (for calibration/eval)."""
        embedder = self.embedder()
        if embedder is None:
            return []
        text = self.query_text(frame)
        q_vec = embedder.embed([text])[0]
        fused = rrf_fuse([c for c, _ in self.vectors.search(q_vec, VECTOR_TOP_K)], self.fts(text))
        ids = [cid for cid, _ in fused[: VECTOR_TOP_K + FTS_TOP_K]]
        rows_by_id = self.store.chunks(ids)
        rows = exclude_self([rows_by_id[i] for i in ids if i in rows_by_id], frame)
        cos = self.vectors.scores(q_vec, [int(r["id"]) for r in rows])
        return [(int(r["id"]), cos.get(int(r["id"]), -1.0)) for r in rows]


class Planner:
    def __init__(self, store: Store, resolver: Resolver, precedent: PrecedentSearch | None) -> None:
        self.store = store
        self.resolver = resolver
        self.precedent = precedent

    def plan(
        self, frame: ContextFrame, checkpoint: Callable[[], None] = lambda: None
    ) -> list[Candidate]:
        candidates: list[Candidate] = []
        line = cursor_line(frame, self.store)
        text_before = _text_before_cursor(frame, line)

        # A. Exact API resolution (highest precision).
        cur = self.resolver.resolve_cursor(frame)
        if cur is not None:
            short = str(cur.row["qualname"]).split(".")[-1]
            from ..cards.build import active_argument

            candidates.append(
                Candidate(
                    row=cur.row,
                    kind="api",
                    confidence=CONF_CURSOR,
                    reason=_reason(cur.step),
                    display=cur.display,
                    is_cursor=True,
                    active=active_argument(text_before, short) if text_before else None,
                )
            )
        checkpoint()
        for loc in frame.nearby_definitions[:5]:
            res = self.resolver.resolve_loc(loc, None, frame)
            if res is not None and res.row["kind"] == "api":
                candidates.append(
                    Candidate(
                        row=res.row,
                        kind="api",
                        confidence=CONF_NEARBY,
                        reason="Name on this line",
                        display=res.display,
                    )
                )
        checkpoint()

        # B. Diagnostics: identifiers mentioned in error messages.
        if frame.trigger == "diagnostic":
            for ident in diagnostic_identifiers([d.message for d in frame.diagnostics])[:6]:
                res = self.resolver.lookup_name(ident, frame)
                if res is not None:
                    candidates.append(
                        Candidate(
                            row=res.row,
                            kind="api",
                            confidence=CONF_DIAGNOSTIC,
                            reason="Mentioned in a diagnostic",
                            display=res.display,
                        )
                    )
            checkpoint()

        # Explicit question: names written in the question itself.
        if frame.trigger == "explicit" and frame.explicit_question:
            names = DOTTED.findall(frame.explicit_question) + [
                m.group(1) for m in _QUOTED.finditer(frame.explicit_question)
            ]
            for ident in list(dict.fromkeys(names))[:4]:
                res = self.resolver.lookup_name(ident, frame)
                if res is not None:
                    candidates.append(
                        Candidate(
                            row=res.row,
                            kind="api",
                            confidence=CONF_EXPLICIT,
                            reason="Named in your question",
                            display=res.display,
                        )
                    )
            checkpoint()

        # C. Precedent search (own code).
        if self.precedent is not None:
            candidates.extend(self.precedent.search(frame))
        return candidates


def _reason(step: str) -> str:
    return {
        "exact_span": "Cursor on resolved symbol",
        "stub_path": "Cursor on resolved symbol (via stubs)",
        "hover": "Cursor on symbol (from hover)",
        "imports": "Cursor on imported name",
        "local_type": "Cursor on a method; type inferred from this code",
    }.get(step, "Cursor on symbol")


def _text_before_cursor(frame: ContextFrame, line: str | None) -> str | None:
    if frame.enclosing_text and frame.enclosing_range is not None:
        lines = split_lines(frame.enclosing_text)
        idx = frame.cursor.line - frame.enclosing_range.start_line
        if 0 <= idx < len(lines):
            return "\n".join(lines[:idx] + [lines[idx][: frame.cursor.character]])
    if line is not None:
        return line[: frame.cursor.character]
    return None


__all__ = ["Planner", "PrecedentSearch", "exclude_self", "identifiers"]
