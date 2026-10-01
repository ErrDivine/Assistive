"""``verify_fact``: invariant I3.

The cited span is loaded fresh (from disk, from the stored chunks for runtime
docs, or from git for code recovered from history), whitespace is normalized,
and the fact text must be a substring of it. Signature facts, which griffe
renders rather than copies, must name a ``def``/``class`` of that name inside
their span.
"""

from __future__ import annotations

import logging
import re
import subprocess
import threading
from collections import OrderedDict
from collections.abc import Callable

from ..index.pyast import norm_ws, split_lines
from ..models import Fact, SourceRef

log = logging.getLogger(__name__)

LineSource = Callable[[SourceRef], "list[str] | None"]


class GitBlobCache:
    """``git show <rev>:<path>`` with a small LRU cache."""

    def __init__(self) -> None:
        self._data: OrderedDict[tuple[str, str, str], list[str] | None] = OrderedDict()
        self._lock = threading.Lock()

    def lines(self, repo: str, rev: str, rel_path: str) -> list[str] | None:
        key = (repo, rev, rel_path)
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
                return self._data[key]
        try:
            out = subprocess.run(
                ["git", "-C", repo, "show", f"{rev}:{rel_path}"],
                capture_output=True,
                timeout=10,
                check=False,
            )
            lines = (
                split_lines(out.stdout.decode("utf-8", errors="replace"))
                if out.returncode == 0
                else None
            )
        except (OSError, subprocess.SubprocessError):
            lines = None
        with self._lock:
            self._data[key] = lines
            while len(self._data) > 64:
                self._data.popitem(last=False)
        return lines


def span_text(lines: list[str], ref: SourceRef) -> str | None:
    if ref.start_line < 1 or ref.end_line > len(lines):
        return None
    return norm_ws(" ".join(lines[ref.start_line - 1 : ref.end_line]))


_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def verify_fact(fact: Fact, load_lines: LineSource) -> bool:
    lines = load_lines(fact.span)
    if lines is None:
        log.warning("verify_fact: cannot load %s", fact.span.path)
        return False
    hay = span_text(lines, fact.span)
    if hay is None:
        log.warning(
            "verify_fact: span %s:%d-%d out of range",
            fact.span.path,
            fact.span.start_line,
            fact.span.end_line,
        )
        return False
    if fact.label == "signature" and fact.origin == "signature":
        m = _NAME.match(fact.text)
        if not m:
            return False
        name = re.escape(m.group(0))
        ok = re.search(rf"\b(?:def|class)\s+{name}\b", hay) is not None
    else:
        ok = norm_ws(fact.text) in hay
    if not ok:
        log.warning(
            "verify_fact: dropped %s fact for %s:%d-%d",
            fact.label,
            fact.span.path,
            fact.span.start_line,
            fact.span.end_line,
        )
    return ok
