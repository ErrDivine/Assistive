"""verify_fact (invariant I3)."""

from __future__ import annotations

from pathlib import Path

from rail_server.cards.verify import verify_fact
from rail_server.models import Fact, RuntimeInfo, SourceRef

SRC = '''def get(url, params=None):
    """Sends a GET
    request.

    :param url: URL for the new request.
    """
    return url
'''


def _loader(tmp_path: Path):  # type: ignore[no-untyped-def]
    p = tmp_path / "m.py"
    p.write_text(SRC)
    lines = SRC.splitlines()
    return str(p), (lambda ref: lines if ref.path == str(p) else None)


def _fact(
    path: str, text: str, start: int, end: int, label: str = "summary", origin: str = "docstring"
) -> Fact:
    return Fact(
        label=label,
        text=text,
        origin=origin,  # type: ignore[arg-type]
        span=SourceRef(path=path, start_line=start, end_line=end),
    )


def test_verbatim_after_whitespace_normalization(tmp_path: Path) -> None:
    path, load = _loader(tmp_path)
    assert verify_fact(_fact(path, "Sends a GET request.", 2, 3), load)
    assert verify_fact(_fact(path, "url: URL for the new request.", 5, 5, "param"), load)


def test_paraphrase_and_wrong_span_fail(tmp_path: Path) -> None:
    path, load = _loader(tmp_path)
    assert not verify_fact(_fact(path, "Sends an HTTP GET request.", 2, 3), load)
    assert not verify_fact(_fact(path, "Sends a GET request.", 5, 5), load)  # text elsewhere
    assert not verify_fact(_fact(path, "Sends a GET request.", 2, 99), load)  # out of range
    assert not verify_fact(_fact("/nope.py", "x", 1, 1), load)


def test_signature_needs_def_in_span(tmp_path: Path) -> None:
    path, load = _loader(tmp_path)
    sig = "get(url: str, params: dict | None = None) -> Response"
    assert verify_fact(_fact(path, sig, 1, 1, "signature", "signature"), load)
    assert not verify_fact(_fact(path, "post(url)", 1, 1, "signature", "signature"), load)


def test_runtime_doc_checked_against_stored_text() -> None:
    lines = ["builtins.dict.get", "get(self, key, default=None, /)", "Return the value."]

    def load(ref: SourceRef) -> list[str]:
        return lines

    span = SourceRef(
        path="runtime:3.12.4/builtins",
        start_line=2,
        end_line=2,
        runtime=RuntimeInfo(python_version="3.12.4"),
    )
    ok = Fact(
        label="signature", text="get(self, key, default=None, /)", origin="runtime_doc", span=span
    )
    bad = Fact(label="signature", text="get(self, key)", origin="runtime_doc", span=span)
    assert verify_fact(ok, load)
    assert not verify_fact(bad, load)
