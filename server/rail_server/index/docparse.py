"""Docstring section parsing with line offsets (design plan §9.3 step 3).

griffe parses the sections. It does not report where each item sits, so every
item's text is located in the docstring's source lines here. The stored
``text`` of each item is cut from the normalized source window itself, which
makes it a verbatim substring of the span it cites (invariant I3).
"""

from __future__ import annotations

import logging
from typing import Any

import griffe

from .pyast import clip_words, locate, norm_ws

logging.getLogger("griffe").setLevel(logging.ERROR)

STYLES: tuple[griffe.DocstringStyle, ...] = ("google", "numpy", "sphinx")
MAX_ITEMS = 12


def _window_text(lines: list[str], base: int, start: int, end: int) -> str:
    return norm_ws(" ".join(lines[start - base : end - base + 1]))


def _item_text(
    lines: list[str], base: int, name: str | None, description: str
) -> tuple[str, int, int] | None:
    """Verbatim fact text running from ``name`` (if given) through the description."""
    desc = norm_ws(description)
    if not desc:
        return None
    span = locate(lines, base, desc)
    if span is None:
        return None
    start, end = span
    if name:
        # The name may sit up to two lines above the description (numpy style).
        for extra in range(0, 3):
            s = max(base, start - extra)
            window = _window_text(lines, base, s, end)
            d_idx = window.rfind(desc)
            n_idx = window.rfind(name, 0, d_idx if d_idx >= 0 else None)
            if d_idx >= 0 and n_idx >= 0:
                return clip_words(window[n_idx : d_idx + len(desc)]), s, end
    return clip_words(desc), start, end


def _annotation(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text and text != "None" else None


def summary_of(docstring: str) -> str:
    """First paragraph of a docstring, whitespace-normalized."""
    para: list[str] = []
    for line in docstring.strip().splitlines():
        if not line.strip():
            if para:
                break
            continue
        para.append(line)
    return norm_ws(" ".join(para))


def parse_sections(
    doc: griffe.Docstring | None, file_lines: list[str], parent: Any = None
) -> dict[str, Any] | None:
    """Return ``{"style", "summary", "sections"}`` with absolute line numbers."""
    if doc is None or not doc.value or doc.lineno is None:
        return None
    base = int(doc.lineno)
    end = int(doc.endlineno or doc.lineno)
    lines = file_lines[base - 1 : end]
    result: dict[str, Any] = {"style": None, "summary": None, "sections": []}

    summary = summary_of(doc.value)
    if summary:
        span = locate(lines, base, summary)
        if span:
            result["summary"] = {
                "text": clip_words(summary),
                "start": span[0],
                "end": span[1],
            }

    for style in STYLES:
        try:
            ds = griffe.Docstring(doc.value, lineno=base, endlineno=end, parent=parent)
            sections = ds.parse(style, warnings=False)
        except Exception:
            continue
        structured = [s for s in sections if s.kind.value != "text"]
        if not structured:
            continue
        result["style"] = style
        for section in structured:
            kind = section.kind.value
            if kind not in ("parameters", "other_parameters", "returns", "yields", "raises"):
                continue
            items = []
            for el in list(section.value)[:MAX_ITEMS]:
                description = getattr(el, "description", "") or ""
                name = getattr(el, "name", None) or None
                annotation = _annotation(getattr(el, "annotation", None))
                if kind == "raises":
                    name = annotation or name
                if kind in ("returns", "yields"):
                    located = _item_text(lines, base, None, description)
                else:
                    located = _item_text(lines, base, name, description)
                if located is None:
                    continue
                text, s, e = located
                items.append(
                    {
                        "name": name,
                        "annotation": annotation,
                        "text": text,
                        "start": s,
                        "end": e,
                    }
                )
            if items:
                result["sections"].append({"kind": kind, "items": items})
        break
    if result["summary"] is None and not result["sections"]:
        return None
    return result
