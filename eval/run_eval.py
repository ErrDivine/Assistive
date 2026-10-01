"""Evaluation harness (design plan §12 Phase 6, §13).

Builds the fixture index, replays ``eval/queries.jsonl`` through the real query
path and reports, per query kind: recall@3, MRR, precision at the confidence
threshold, empty-result rate and latency p50/p95. Also:

* ``--calibrate``: choose ``precedent_threshold`` (precision ≥ 0.8, max recall);
* ``--spike``: compare embedding models on precedent recall@3 and latency;
* ``--check BASELINE``: exit 1 on a regression greater than 5 %;
* ``--replay FILE``: re-run frames recorded with ``referenceRail.recordSessions``;
* ``--api-frames N``: API-path latency over N replayed frames (Phase 1 check).

Run with networking disabled: ``RAIL_NO_NETWORK=1`` (or ``--no-network``)
makes every non-loopback connection fail.
"""

from __future__ import annotations

import argparse
import ast
import io
import json
import math
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
FIXTURES = HERE / "fixtures"
APP = FIXTURES / "fixture_app"
HISTORY = FIXTURES / "fixture_history"
STUBS = FIXTURES / "src" / "stubs"
QUERIES = HERE / "queries.jsonl"
sys.path.insert(0, str(REPO / "server"))

TOP_K = 3
REGRESSION_TOLERANCE = 0.05
LATENCY_BUDGET_P95 = {"api": 150.0, "diagnostic": 150.0, "precedent": 400.0}


def disable_network() -> None:
    real = socket.socket.connect

    def connect(self: socket.socket, address: Any) -> Any:
        host = address[0] if isinstance(address, tuple) else address
        if self.family in (socket.AF_INET, socket.AF_INET6) and host not in (
            "127.0.0.1", "::1", "localhost",
        ):
            raise OSError(f"network disabled for evaluation: {address!r}")
        return real(self, address)

    socket.socket.connect = connect  # type: ignore[method-assign]


def venv_python() -> Path:
    return FIXTURES / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[max(1, math.ceil(p / 100 * len(ordered))) - 1], 2)


# -- frame construction -------------------------------------------------------


def enclosing_range(lines: list[str], line: int) -> tuple[int, int]:
    """Same rule as the extension's indentation fallback (pyscope.ts)."""
    def indent(s: str) -> int:
        return len(s) - len(s.lstrip())

    def blank(s: str) -> bool:
        return not s.strip() or s.lstrip().startswith("#")

    cursor_indent = math.inf
    for i in range(line, -1, -1):
        if not blank(lines[i]):
            cursor_indent = indent(lines[i])
            break
    for i in range(line, -1, -1):
        text = lines[i]
        stripped = text.lstrip()
        if not (stripped.startswith(("def ", "class ", "async def "))):
            continue
        ind = indent(text)
        if i != line and ind >= cursor_indent:
            continue
        start = i
        while start > 0 and lines[start - 1].lstrip().startswith("@"):
            start -= 1
        end = i
        for j in range(i + 1, len(lines)):
            if blank(lines[j]):
                continue
            if indent(lines[j]) <= ind:
                break
            end = j
        if end >= line:
            return start, end
        cursor_indent = ind
    return max(0, line - 40), min(len(lines) - 1, line + 40)


def locate(lines: list[str], at: dict[str, Any]) -> tuple[int, int]:
    seen = 0
    for i, text in enumerate(lines):
        col = text.find(at["find"])
        if col >= 0:
            seen += 1
            if seen == at.get("occurrence", 1):
                return i, col + int(at.get("offset", 0))
    raise ValueError(f"{at['find']!r} not found")


def ident_at(line: str, col: int) -> str | None:
    import re

    for m in re.finditer(r"[A-Za-z_][A-Za-z0-9_]*", line):
        if m.start() <= col <= m.end():
            return m.group(0)
    return None


class Definitions:
    """Simulated go-to-definition targets (what Pylance would report)."""

    def __init__(self, probe: dict[str, Any]) -> None:
        self.modules: dict[str, str] = {}
        for d in probe.get("dists", []):
            for path, mod in zip(d.get("py_files", []), d.get("modules", [])):
                self.modules.setdefault(mod, path)
        std = probe.get("stdlib") or {}
        for path, mod in zip(std.get("py_files", []), std.get("modules", [])):
            self.modules.setdefault(mod, path)

    @staticmethod
    def _find(path: str, qualname: str) -> dict[str, Any] | None:
        tree = ast.parse(Path(path).read_text(encoding="utf-8", errors="replace"))
        node: ast.AST = tree
        for part in qualname.split("."):
            nxt = None
            for child in getattr(node, "body", []):
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and (
                    child.name == part
                ):
                    nxt = child
            if nxt is None:
                return None
            node = nxt
        lines = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
        line = node.lineno - 1  # type: ignore[attr-defined]
        col = lines[line].find(qualname.split(".")[-1], node.col_offset)  # type: ignore[attr-defined]
        return {"path": path, "line": line, "character": max(col, 0)}

    def resolve(self, spec: dict[str, Any] | None) -> dict[str, Any] | None:
        if not spec:
            return None
        if "module" in spec:
            path = self.modules.get(spec["module"])
            return self._find(path, spec["qualname"]) if path else None
        if "stub" in spec:
            path = str(STUBS / f"{spec['stub']}.pyi")
            qual = ".".join(p for p in (spec.get("class"), spec["name"]) if p)
            return self._find(path, qual)
        if "workspace" in spec:
            return self._find(str(APP / spec["workspace"]), spec["qualname"])
        return None


def build_frame(q: dict[str, Any], rid: int, defs: Definitions) -> dict[str, Any]:
    if q["kind"] == "precedent":
        text = q["enclosing_text"]
        lines = text.splitlines()
        try:
            line, col = locate(lines, q["at"]) if q.get("at") else (len(lines) - 1, 0)
        except ValueError:
            line, col = len(lines) - 1, 0
        sym = ident_at(lines[line], col)
        frame = {
            "requestId": rid,
            "trigger": q.get("trigger", "edit_pause"),
            "docUri": (APP / q["file"]).as_uri(),
            "languageId": "python",
            "cursor": {"line": line, "character": col},
            "enclosingText": text,
            "enclosingRange": {"startLine": 0, "endLine": len(lines) - 1},
            "nearbyDefinitions": [],
            "recentEdits": [
                {"line": i, "text": t, "ts": 0} for i, t in enumerate(q.get("recent_edits") or [])
            ],
            "diagnostics": [],
        }
        if sym:
            frame["symbolAtCursor"] = {"text": sym}
    else:
        path = APP / q["file"]
        lines = path.read_text(encoding="utf-8").splitlines()
        line, col = locate(lines, q["at"])
        start, end = enclosing_range(lines, line)
        sym = ident_at(lines[line], col)
        frame = {
            "requestId": rid,
            "trigger": q.get("trigger", "cursor_pause"),
            "docUri": path.as_uri(),
            "languageId": "python",
            "cursor": {"line": line, "character": col},
            "enclosingText": "\n".join(lines[start : end + 1])[:4096],
            "enclosingRange": {"startLine": start, "endLine": end},
            "nearbyDefinitions": [],
            "recentEdits": [],
            "diagnostics": [
                {"message": d["message"], "line": line + int(d.get("line_offset", 0)),
                 "source": d.get("source")}
                for d in q.get("diagnostics") or []
            ],
        }
        if sym:
            symbol: dict[str, Any] = {"text": sym}
            loc = defs.resolve(q.get("definition"))
            if loc:
                symbol["definition"] = loc
            if q.get("hover"):
                symbol["hoverText"] = q["hover"]
            frame["symbolAtCursor"] = symbol
    if q.get("question"):
        frame["explicitQuestion"] = q["question"]
    return frame


# -- index ---------------------------------------------------------------------


def run_probe() -> dict[str, Any]:
    from rail_server.server import PROBE_SCRIPT

    out = subprocess.run(
        [str(venv_python()), str(PROBE_SCRIPT)], capture_output=True, check=True, timeout=180
    )
    return json.loads(out.stdout)


def make_server(home: Path, probe: dict[str, Any], *, backend: str, model: str | None,
                threshold: float | None, sync: bool = True):  # type: ignore[no-untyped-def]
    import asyncio

    from rail_server.index import worker
    from rail_server.rpc import Endpoint
    from rail_server.server import RailServer

    os.environ["REFERENCE_RAIL_HOME"] = str(home)
    server = RailServer(Endpoint(io.BytesIO()))
    config: dict[str, Any] = {
        "embeddingBackend": backend,
        "extraRepos": [str(HISTORY)],
        "dataDir": str(home),
    }
    if model:
        config["embeddingModel"] = model
    if threshold is not None:
        config["precedentThreshold"] = threshold

    async def init() -> None:
        await server.initialize({
            "workspaceRoots": [str(APP)], "pythonPath": str(venv_python()),
            "config": config, "noAutoIndex": True,
        })

    asyncio.run(init())
    server._set_probe(probe)
    if sync:
        t0 = time.monotonic()
        res = worker.run_sync(server.cfg.to_worker(), probe, [str(APP)], [str(HISTORY)])
        print(f"index built in {time.monotonic() - t0:.1f}s: {json.dumps(res)[:300]}",
              file=sys.stderr)
    server._load_embedder_and_vectors()
    return server


# -- evaluation ----------------------------------------------------------------


def evaluate(server: Any, queries: list[dict[str, Any]], defs: Definitions) -> dict[str, Any]:
    from rail_server.models import ContextFrame

    per_kind: dict[str, dict[str, Any]] = {}
    details = []
    for i, q in enumerate(queries):
        frame = ContextFrame.model_validate(build_frame(q, i + 1, defs))
        t0 = time.perf_counter()
        cards = server.query_sync(frame)
        ms = (time.perf_counter() - t0) * 1000
        kind = q["kind"]
        if kind == "precedent":
            cards = [c for c in cards if c.kind == "precedent"]
        quals = [c.qualname for c in cards[:TOP_K]]
        expected = set(q.get("expected") or [])
        hits = [i for i, qn in enumerate(quals) if qn in expected]
        k = per_kind.setdefault(kind, {
            "queries": 0, "positives": 0, "found": 0, "rr": 0.0, "shown": 0, "correct": 0,
            "empty": 0, "latencies": [], "neg_false_positive": 0, "negatives": 0,
        })
        k["queries"] += 1
        k["latencies"].append(ms)
        k["shown"] += len(quals)
        k["correct"] += len(hits)
        k["empty"] += int(not quals)
        if expected:
            k["positives"] += 1
            if hits:
                k["found"] += 1
                k["rr"] += 1.0 / (hits[0] + 1)
        else:
            k["negatives"] += 1
            k["neg_false_positive"] += int(bool(quals))
        details.append({
            "id": q["id"], "kind": kind, "expected": sorted(expected), "got": quals,
            "confidence": [c.confidence for c in cards[:TOP_K]], "ok": bool(hits) or (
                not expected and not quals), "ms": round(ms, 2),
        })
    metrics: dict[str, Any] = {}
    for kind, k in sorted(per_kind.items()):
        metrics[kind] = {
            "queries": k["queries"],
            "recall_at_3": round(k["found"] / k["positives"], 4) if k["positives"] else None,
            "mrr": round(k["rr"] / k["positives"], 4) if k["positives"] else None,
            "precision": round(k["correct"] / k["shown"], 4) if k["shown"] else 1.0,
            "negative_false_positive_rate": (
                round(k["neg_false_positive"] / k["negatives"], 4) if k["negatives"] else None
            ),
            "empty_rate": round(k["empty"] / k["queries"], 4),
            "latency_p50_ms": percentile(k["latencies"], 50),
            "latency_p95_ms": percentile(k["latencies"], 95),
        }
    return {"metrics": metrics, "details": details}


def api_latency(server: Any, queries: list[dict[str, Any]], defs: Definitions, n: int) -> dict[str, Any]:
    from rail_server.models import ContextFrame

    api = [q for q in queries if q["kind"] == "api"]
    frames = [build_frame(q, 0, defs) for q in api]
    lat = []
    for i in range(n):
        f = dict(frames[i % len(frames)])
        f["requestId"] = 10_000 + i
        frame = ContextFrame.model_validate(f)
        t0 = time.perf_counter()
        server.query_sync(frame)
        lat.append((time.perf_counter() - t0) * 1000)
    return {"frames": n, "p50_ms": percentile(lat, 50), "p95_ms": percentile(lat, 95),
            "max_ms": round(max(lat), 2)}


def calibrate(server: Any, queries: list[dict[str, Any]], defs: Definitions,
              min_precision: float = 0.8) -> dict[str, Any]:
    """Pick the threshold with the best recall@3 subject to precision ≥ 0.8."""
    from rail_server.models import ContextFrame

    planner = server.planner
    assert planner is not None and planner.precedent is not None
    scored = []
    for i, q in enumerate(x for x in queries if x["kind"] == "precedent"):
        frame = ContextFrame.model_validate(build_frame(q, 50_000 + i, defs))
        hits = planner.precedent.raw_scores(frame)
        rows = server.store.chunks([cid for cid, _ in hits])
        labeled = [(cos, rows[cid]["qualname"] in set(q["expected"])) for cid, cos in hits
                   if cid in rows]
        scored.append((labeled, bool(q["expected"])))
    table = []
    for t100 in range(20, 96):
        thr = t100 / 100
        shown = correct = found = positives = 0
        for labeled, positive in scored:
            # Mirror the planner: fused order, gate on cosine, keep top 3.
            kept = [ok for cos, ok in labeled if cos >= thr][:TOP_K]
            shown += len(kept)
            correct += sum(kept)
            if positive:
                positives += 1
                found += int(any(kept))
        precision = correct / shown if shown else 1.0
        recall = found / positives if positives else 0.0
        table.append({"threshold": thr, "precision": round(precision, 4),
                      "recall_at_3": round(recall, 4), "shown": shown})
    ok = [r for r in table if r["precision"] >= min_precision and r["shown"] > 0]
    best = max(ok, key=lambda r: (r["recall_at_3"], -r["threshold"])) if ok else None
    return {"chosen": best, "table": table}


def spike(probe: dict[str, Any], queries: list[dict[str, Any]], defs: Definitions,
          base_home: Path) -> list[dict[str, Any]]:
    """Compare embedders on precedent queries (recall@3 at the calibrated threshold)."""
    import shutil

    from rail_server.index.embeddings import get_embedder, local_model_path

    candidates: list[tuple[str, str | None]] = [("hashing", None)]
    models_dir = Path(os.environ.get("RAIL_MODELS_DIR", Path.home() / ".reference-rail" / "models"))
    backends = os.environ.get("RAIL_SPIKE_BACKENDS", "fastembed").split(",")
    for model in ("sentence-transformers/all-MiniLM-L6-v2", "BAAI/bge-small-en",
                  "BAAI/bge-small-en-v1.5", "BAAI/bge-base-en-v1.5"):
        if local_model_path(models_dir, model):
            candidates.extend((b, model) for b in backends)
    rows = []
    for backend, model in candidates:
        home = base_home / f"spike-{backend}-{(model or '').replace('/', '_')}"
        shutil.rmtree(home, ignore_errors=True)
        home.mkdir(parents=True)
        if model:
            (home / "models").symlink_to(models_dir, target_is_directory=True)
        server = make_server(home, probe, backend=backend, model=model, threshold=0.0)
        cal = calibrate(server, queries, defs)
        thr = cal["chosen"]["threshold"] if cal["chosen"] else 0.99
        print(f"calibrated {server._embedder.name}: {cal['chosen']}", file=sys.stderr)
        server.cfg.precedent_threshold = thr
        res = evaluate(server, [q for q in queries if q["kind"] == "precedent"], defs)
        emb = get_embedder(backend, model or "", home / "models")
        texts = [q["enclosing_text"] for q in queries if q["kind"] == "precedent"]
        t0 = time.perf_counter()
        for t in texts:
            emb.embed([t])
        per_query = (time.perf_counter() - t0) * 1000 / max(1, len(texts))
        m = res["metrics"]["precedent"]
        rows.append({
            "embedder": server._embedder.name, "threshold": thr,
            "recall_at_3": m["recall_at_3"], "precision": m["precision"], "mrr": m["mrr"],
            "embed_ms_per_query": round(per_query, 2), "latency_p95_ms": m["latency_p95_ms"],
        })
        server.close()
    return rows


def check(results: dict[str, Any], baseline_path: Path) -> list[str]:
    """Regressions: quality metrics more than 5 % below baseline, or a latency
    p95 over its §10 budget (absolute budgets: CI timing is too noisy for a
    relative latency gate)."""
    configs = json.loads(baseline_path.read_text())["configs"]
    if results["embedder"] not in configs:
        return [f"no baseline for embedder {results['embedder']} (have: {sorted(configs)})"]
    baseline = configs[results["embedder"]]
    problems = []
    for kind, base in baseline["metrics"].items():
        cur = results["metrics"].get(kind)
        if cur is None:
            problems.append(f"{kind}: missing from results")
            continue
        for key in ("recall_at_3", "mrr", "precision"):
            b, c = base.get(key), cur.get(key)
            if b is None or c is None:
                continue
            if c < b * (1 - REGRESSION_TOLERANCE):
                problems.append(f"{kind}.{key}: {c} < baseline {b} - 5%")
        for key in ("negative_false_positive_rate", "empty_rate"):
            b, c = base.get(key), cur.get(key)
            if b is None or c is None:
                continue
            if c > b + max(REGRESSION_TOLERANCE, b * REGRESSION_TOLERANCE):
                problems.append(f"{kind}.{key}: {c} > baseline {b} + 5%")
        budget = LATENCY_BUDGET_P95.get(kind)
        if budget and cur.get("latency_p95_ms") and cur["latency_p95_ms"] > budget:
            problems.append(f"{kind}.latency_p95_ms {cur['latency_p95_ms']} > budget {budget}")
    api = results.get("api_latency")
    if api and api["p95_ms"] > LATENCY_BUDGET_P95["api"]:
        problems.append(f"api_latency.p95_ms {api['p95_ms']} > budget 150")
    return problems


def replay(server: Any, path: Path) -> dict[str, Any]:
    from rail_server.models import ContextFrame

    lat: list[float] = []
    empty: dict[str, list[int]] = {}
    for line in path.read_text().splitlines():
        rec = json.loads(line)
        if rec.get("superseded"):
            continue
        frame = ContextFrame.model_validate(rec["frame"])
        t0 = time.perf_counter()
        cards = server.query_sync(frame)
        lat.append((time.perf_counter() - t0) * 1000)
        empty.setdefault(frame.trigger, []).append(int(not cards))
    return {
        "frames": len(lat), "p50_ms": percentile(lat, 50), "p95_ms": percentile(lat, 95),
        "empty_rate": {t: round(sum(v) / len(v), 4) for t, v in empty.items()},
    }


def markdown(results: dict[str, Any]) -> str:
    out = ["| kind | queries | recall@3 | MRR | precision | neg. FP rate | empty | p50 ms | p95 ms |",
           "|---|---|---|---|---|---|---|---|---|"]
    for kind, m in results["metrics"].items():
        out.append(
            f"| {kind} | {m['queries']} | {m['recall_at_3']} | {m['mrr']} | {m['precision']} | "
            f"{m['negative_false_positive_rate']} | {m['empty_rate']} | {m['latency_p50_ms']} | "
            f"{m['latency_p95_ms']} |"
        )
    if results.get("api_latency"):
        a = results["api_latency"]
        out.append(f"\nAPI path over {a['frames']} replayed frames: p50 {a['p50_ms']} ms, "
                   f"p95 {a['p95_ms']} ms, max {a['max_ms']} ms.")
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--queries", type=Path, default=QUERIES)
    ap.add_argument("--home", type=Path, help="index directory to (re)use (default: temp)")
    ap.add_argument("--backend", default="hashing")
    ap.add_argument("--model", default=None)
    ap.add_argument("--threshold", type=float, default=None)
    ap.add_argument("--no-sync", action="store_true", help="reuse --home without re-indexing")
    ap.add_argument("--calibrate", action="store_true")
    ap.add_argument("--spike", action="store_true")
    ap.add_argument("--api-frames", type=int, default=500)
    ap.add_argument("--check", type=Path)
    ap.add_argument("--write-baseline", type=Path)
    ap.add_argument("--replay", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--no-network", action="store_true")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args()

    if args.no_network or os.environ.get("RAIL_NO_NETWORK") == "1":
        disable_network()
    import logging

    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    if not venv_python().exists() or not APP.exists():
        print("Fixtures missing: run python eval/fixtures/make_fixtures.py", file=sys.stderr)
        return 2
    queries = [json.loads(line) for line in args.queries.read_text().splitlines() if line.strip()]
    probe = run_probe()
    defs = Definitions(probe)
    tmp = None
    home = args.home
    if home is None:
        tmp = tempfile.TemporaryDirectory(prefix="rail-eval-")
        home = Path(tmp.name)
    home.mkdir(parents=True, exist_ok=True)
    results: dict[str, Any] = {}
    if args.spike:
        rows = spike(probe, queries, defs, home)
        results["spike"] = rows
        for r in rows:
            print(json.dumps(r))
    server = make_server(home, probe, backend=args.backend, model=args.model,
                         threshold=args.threshold, sync=not args.no_sync)
    results["embedder"] = server._embedder.name
    results["threshold"] = server.threshold()
    if args.calibrate:
        cal = calibrate(server, queries, defs)
        results["calibration"] = cal
        print("calibrated:", json.dumps(cal["chosen"]))
        if cal["chosen"]:
            server.cfg.precedent_threshold = cal["chosen"]["threshold"]
            results["threshold"] = cal["chosen"]["threshold"]
    if args.replay:
        results["replay"] = replay(server, args.replay)
        print(json.dumps(results["replay"], indent=2))
    ev = evaluate(server, queries, defs)
    results.update(ev)
    if args.api_frames:
        results["api_latency"] = api_latency(server, queries, defs, args.api_frames)
    print(markdown(results))
    if args.verbose:
        for d in ev["details"]:
            if not d["ok"]:
                print("MISS", json.dumps(d))
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "results.json").write_text(json.dumps(results, indent=2))
        (args.out / "summary.md").write_text(markdown(results))
    if args.write_baseline:
        existing = (
            json.loads(args.write_baseline.read_text()) if args.write_baseline.exists()
            else {"configs": {}}
        )
        existing["configs"][results["embedder"]] = {
            "threshold": results["threshold"], "metrics": results["metrics"],
            "api_latency": results.get("api_latency"),
        }
        args.write_baseline.write_text(json.dumps(existing, indent=2, sort_keys=True) + "\n")
    server.close()
    if args.check:
        problems = check(results, args.check)
        if problems:
            print("REGRESSIONS:\n  " + "\n  ".join(problems), file=sys.stderr)
            return 1
        print("no regressions against", args.check)
    return 0


if __name__ == "__main__":
    sys.exit(main())
