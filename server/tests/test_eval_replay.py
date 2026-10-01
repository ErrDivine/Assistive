"""Phase 6: recorded sessions replay through the evaluation harness."""

from __future__ import annotations

import json
from pathlib import Path

from conftest import FIXTURE_APP, frame, needs_fixtures

pytestmark = needs_fixtures


def test_replay_recorded_session(indexed_server, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    import run_eval

    path = FIXTURE_APP / "app" / "client.py"
    lines = path.read_text().splitlines()
    line = next(i for i, t in enumerate(lines) if "requests.get(" in t)
    col = lines[line].index("requests.get(") + 10
    rec = tmp_path / "session.jsonl"
    with rec.open("w") as fh:
        for i, trig in enumerate(["cursor_pause", "cursor_pause", "edit_pause"]):
            f = frame(
                requestId=70_000 + i,
                trigger=trig,
                docUri=path.as_uri(),
                cursor={"line": line, "character": col},
                symbolAtCursor={"text": "get"},
            )
            fh.write(json.dumps({"frame": f, "superseded": i == 0, "cards": []}) + "\n")
    out = run_eval.replay(indexed_server, rec)
    assert out["frames"] == 2  # superseded frames are skipped
    assert out["empty_rate"]["cursor_pause"] == 0.0
    assert out["p95_ms"] is not None and out["p95_ms"] < 150
