"""rail-server: request handlers wired to the index, planner and card builder."""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import multiprocessing as mp
import os
import sys
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future, ProcessPoolExecutor
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from .cards.build import CardBuilder
from .config import SERVER_VERSION, Config
from .index import worker
from .index.code import embed_ids, excluded, index_file, resolve_roots, root_for
from .index.embeddings import Embedder, get_embedder
from .index.library import active_dists
from .memory import lookups
from .metrics.report import build_report
from .models import Card, ContextFrame, Event, QueryResult
from .retrieve.planner import Planner, PrecedentSearch
from .retrieve.ranker import rank
from .retrieve.resolve import Resolver, uri_to_path
from .retrieve.store import Store, is_runtime_path
from .rpc import INVALID_PARAMS, Endpoint, RpcError
from .store.db import ConnectionPool, get_meta, transaction
from .store.vectors import BruteForceIndex

log = logging.getLogger("rail_server")

PROBE_SCRIPT = Path(__file__).parent / "index" / "env_probe.py"
PROBE_TIMEOUT_S = 120


class Abandoned(Exception):
    """A newer request superseded this one."""


class RailServer:
    def __init__(self, endpoint: Endpoint) -> None:
        self.ep = endpoint
        self.cfg = Config()
        self.pool: ConnectionPool | None = None
        self.store: Store | None = None
        self.resolver: Resolver | None = None
        self.builder: CardBuilder | None = None
        self.planner: Planner | None = None
        self.vectors = BruteForceIndex()
        self._embedder: Embedder | None = None
        self._embedder_lock = threading.Lock()
        self.latest_request_id = 0
        self.roots: list[str] = []
        self.python_path: str | None = None
        self.probe: dict[str, Any] | None = None
        self.executor: ProcessPoolExecutor | None = None
        self._mp_queue: Any = None
        self._mp_stop: Any = None
        self._sync_future: Future[Any] | None = None
        self._sync_again = False
        self.last_sync: dict[str, Any] | None = None
        self.recent_cards: OrderedDict[str, tuple[str, int, str | None]] = OrderedDict()
        self.stop = asyncio.Event()
        self.loop: asyncio.AbstractEventLoop | None = None
        self._startup_task: asyncio.Task[Any] | None = None
        self._register()

    # ------------------------------------------------------------------ setup
    def _register(self) -> None:
        ep = self.ep
        ep.request("initialize")(self.initialize)
        ep.request("ping")(self.ping)
        ep.request("index/sync")(self.index_sync)
        ep.request("index/status")(self.index_status)
        ep.notification("index/fileChanged")(self.file_changed)
        ep.request("context/query")(self.context_query)
        ep.notification("events/log")(self.events_log)
        ep.request("memory/frequent")(self.memory_frequent)
        ep.request("memory/pinned")(self.memory_pinned)
        ep.request("memory/pin")(self.memory_pin)
        ep.request("memory/unpin")(self.memory_unpin)
        ep.request("metrics/report")(self.metrics_report)
        ep.request("source/read")(self.source_read)
        ep.request("shutdown")(self.shutdown)
        ep.notification("exit")(self.exit)

    def _require(self) -> Store:
        if self.store is None:
            raise RpcError(-32002, "server not initialized")
        return self.store

    def embedder(self) -> Embedder | None:
        return self._embedder

    def threshold(self) -> float:
        return float(self.cfg.precedent_threshold)

    # ------------------------------------------------------------- lifecycle
    async def initialize(self, params: dict[str, Any] | None) -> dict[str, Any]:
        params = params or {}
        self.loop = asyncio.get_running_loop()
        self.cfg = Config.from_client(params.get("config"))
        self.roots = [os.path.realpath(r) for r in params.get("workspaceRoots") or [] if r]
        self.python_path = params.get("pythonPath") or None
        self.pool = ConnectionPool(self.cfg.db_path)
        self.store = Store(self.pool)
        self.resolver = Resolver(self.store)
        self.builder = CardBuilder(self.store)
        precedent = PrecedentSearch(self.store, self.vectors, self.embedder, self.threshold)
        self.planner = Planner(self.store, self.resolver, precedent)
        cached = self._load_cached_probe()
        if cached:
            self._set_probe(cached)
        if not params.get("noAutoIndex"):
            self._startup_task = asyncio.ensure_future(self._startup())
        return {
            "serverVersion": SERVER_VERSION,
            "capabilities": {
                "contextQuery": True,
                "precedent": True,
                "history": self.cfg.index_history,
                "metrics": True,
                "sourceRead": True,
            },
            "dataDir": str(self.cfg.data_dir),
        }

    async def _startup(self) -> None:
        try:
            await asyncio.to_thread(self._load_embedder_and_vectors)
            probe = await self._run_probe()
            if probe is not None:
                self._set_probe(probe)
            self._start_sync()
        except Exception:
            log.exception("startup failed")

    def _load_embedder_and_vectors(self) -> None:
        with self._embedder_lock:
            if self._embedder is None:
                self._embedder = get_embedder(
                    self.cfg.embedding_backend, self.cfg.embedding_model, self.cfg.models_dir
                )
        assert self.pool is not None
        self.vectors.load(self.pool.get(), self._embedder.name)
        log.info("embedder %s, %d vectors", self._embedder.name, len(self.vectors))

    def _probe_cache_path(self) -> Path:
        key = (self.python_path or "default").encode("utf-8")
        import hashlib

        return self.cfg.data_dir / "probe-cache" / f"{hashlib.sha1(key).hexdigest()[:16]}.json"

    def _load_cached_probe(self) -> dict[str, Any] | None:
        try:
            return json.loads(self._probe_cache_path().read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    async def _run_probe(self) -> dict[str, Any] | None:
        exe = self.python_path or "python3"
        try:
            proc = await asyncio.create_subprocess_exec(
                exe,
                str(PROBE_SCRIPT),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            out, err = await asyncio.wait_for(proc.communicate(), PROBE_TIMEOUT_S)
        except (OSError, asyncio.TimeoutError) as e:
            log.error("environment probe with %s failed: %s", exe, e)
            self.ep.notify(
                "index/progress",
                {
                    "phase": "error",
                    "done": 0,
                    "total": 0,
                    "message": f"Could not run the Python interpreter {exe}: {e}",
                },
            )
            return None
        if proc.returncode != 0:
            log.error("environment probe exited %s: %s", proc.returncode, err.decode()[-2000:])
            return None
        try:
            probe = json.loads(out.decode("utf-8"))
        except json.JSONDecodeError:
            log.error("environment probe printed invalid JSON")
            return None
        path = self._probe_cache_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(probe), encoding="utf-8")
        except OSError:
            pass
        return probe

    def _set_probe(self, probe: dict[str, Any]) -> None:
        self.probe = probe
        assert self.store is not None
        self.store.set_active(
            active_dists(probe, include_stdlib=self.cfg.index_stdlib), probe.get("python_version")
        )

    # ------------------------------------------------------------- indexing
    def _ensure_executor(self) -> ProcessPoolExecutor:
        if self.executor is None:
            ctx = mp.get_context("spawn")
            self._mp_queue = ctx.Queue()
            self._mp_stop = ctx.Event()
            self.executor = ProcessPoolExecutor(
                max_workers=1,
                mp_context=ctx,
                initializer=worker.init_worker,
                initargs=(self._mp_queue, self._mp_stop, os.getpid()),
            )
            threading.Thread(target=self._pump_progress, name="progress", daemon=True).start()
        return self.executor

    def _pump_progress(self) -> None:
        q = self._mp_queue
        while not self.stop.is_set():
            try:
                msg = q.get(timeout=0.5)
            except Exception:
                continue
            self.ep.notify("index/progress", msg)
            if msg.get("phase") in ("done",) or (
                msg.get("phase") == "embeddings" and msg.get("done") == msg.get("total")
            ):
                self._reload_vectors_soon()

    def _reload_vectors_soon(self) -> None:
        if self.loop is None:
            return

        def reload() -> None:
            try:
                emb = self._embedder
                if emb is not None and self.pool is not None:
                    self.vectors.load(self.pool.get(), emb.name)
            except Exception:
                log.exception("vector reload failed")

        self.loop.call_soon_threadsafe(lambda: asyncio.ensure_future(asyncio.to_thread(reload)))

    def _start_sync(self, *, library: bool = True) -> bool:
        if self._sync_future is not None and not self._sync_future.done():
            self._sync_again = True
            return False
        executor = self._ensure_executor()
        fn = functools.partial(
            worker.run_sync,
            self.cfg.to_worker(),
            self.probe if library else None,
            list(self.roots),
            list(self.cfg.extra_repos),
            history=self.cfg.index_history,
        )
        self._sync_future = executor.submit(fn)
        self._sync_future.add_done_callback(self._sync_done)
        return True

    def _sync_done(self, fut: Future[Any]) -> None:
        try:
            self.last_sync = fut.result()
            log.info("sync finished: %s", self.last_sync)
        except Exception as e:  # BrokenProcessPool, worker exceptions
            log.error("sync failed: %s", e)
            self.ep.notify(
                "index/progress",
                {"phase": "error", "done": 0, "total": 0, "message": f"Indexing failed: {e}"},
            )
            self.executor = None
        self._reload_vectors_soon()
        if self._sync_again and not self.stop.is_set() and self.loop is not None:
            self._sync_again = False
            self.loop.call_soon_threadsafe(self._start_sync)

    async def index_sync(self, params: dict[str, Any] | None) -> dict[str, Any]:
        self._require()
        roots = (params or {}).get("roots")
        if roots:
            self.roots = [os.path.realpath(r) for r in roots]
        if (params or {}).get("reprobe", True):
            probe = await self._run_probe()
            if probe is not None:
                self._set_probe(probe)
        if (params or {}).get("full"):
            assert self.pool is not None
            conn = self.pool.get()
            with transaction(conn):
                conn.execute("DELETE FROM indexed_dists")
        self._start_sync()
        return {"started": True}

    async def index_status(self, params: Any) -> dict[str, Any]:
        store = self._require()
        stats = await asyncio.to_thread(store.stats)
        assert self.pool is not None
        last = get_meta(self.pool.get(), "last_sync")
        return {
            **stats,
            "lastSync": last,
            "syncing": self._sync_future is not None and not self._sync_future.done(),
            "embedder": self._embedder.name if self._embedder else None,
            "vectors": len(self.vectors),
            "pythonVersion": (self.probe or {}).get("python_version"),
            "pythonPath": self.python_path,
            "dataDir": str(self.cfg.data_dir),
        }

    async def file_changed(self, params: dict[str, Any] | None) -> None:
        path = (params or {}).get("path")
        if not path or self.store is None:
            return
        if path.startswith("file:"):
            path = uri_to_path(path) or path
        await asyncio.to_thread(self._file_changed, path)

    def _file_changed(self, path: str) -> dict[str, Any] | None:
        assert self.store is not None and self.pool is not None
        self.store.lines.invalidate(path)
        if not path.endswith(".py"):
            return None
        roots = resolve_roots([*self.roots, *self.cfg.extra_repos])
        root = root_for(path, roots)
        if root is None:
            return None
        base = root.repo or root.path
        rel = os.path.relpath(os.path.realpath(path), base)
        if excluded(rel):
            return None
        conn = self.pool.get()
        before = {
            int(r[0])
            for r in conn.execute(
                "SELECT id FROM chunks WHERE path = ? AND deleted = 0", (os.path.realpath(path),)
            )
        }
        res = index_file(conn, os.path.realpath(path), root=base, repo=root.repo)
        after = {
            int(r[0])
            for r in conn.execute(
                "SELECT id FROM chunks WHERE path = ? AND deleted = 0", (os.path.realpath(path),)
            )
        }
        self.vectors.remove(sorted(before - after))
        emb = self._embedder
        if emb is not None and res.inserted:
            ids, vecs = embed_ids(conn, emb, res.inserted)
            if ids:
                self.vectors.upsert(ids, vecs)
        log.info("re-indexed %s: %s (+%d -%d)", path, res.status, len(res.inserted), res.removed)
        return {"status": res.status, "inserted": len(res.inserted), "removed": res.removed}

    # ---------------------------------------------------------------- queries
    async def context_query(self, params: dict[str, Any] | None) -> dict[str, Any]:
        self._require()
        try:
            frame = ContextFrame.model_validate(params or {})
        except ValidationError as e:
            raise RpcError(INVALID_PARAMS, f"invalid ContextFrame: {e.errors()[:3]}") from e
        rid = frame.request_id
        if rid > self.latest_request_id:
            self.latest_request_id = rid
        empty = QueryResult(request_id=rid, cards=[]).wire()
        if rid < self.latest_request_id:
            return empty
        t0 = time.perf_counter()
        try:
            cards = await asyncio.to_thread(self._query, frame)
        except Abandoned:
            self._log_query(frame, t0, 0, abandoned=True)
            return empty
        if rid < self.latest_request_id:
            self._log_query(frame, t0, 0, abandoned=True)
            return empty
        self._log_query(frame, t0, len(cards))
        return QueryResult(request_id=rid, cards=cards).wire()

    def _checkpoint(self, frame: ContextFrame) -> None:
        if frame.request_id < self.latest_request_id:
            raise Abandoned()

    def query_sync(self, frame: ContextFrame) -> list[Card]:
        """Synchronous query path (used by tests, eval and the server)."""
        return self._query(frame)

    def _query(self, frame: ContextFrame) -> list[Card]:
        assert self.planner is not None and self.builder is not None
        if frame.language_id != "python":
            return []
        candidates = self.planner.plan(frame, lambda: self._checkpoint(frame))
        self._checkpoint(frame)
        doc = uri_to_path(frame.doc_uri)
        roots = resolve_roots(self.roots) if doc else []
        root = root_for(doc, roots) if doc else None
        ranked = rank(candidates, repo=root.repo if root else None)
        pinned = self._pinned_qualnames()
        cards: list[Card] = []
        for cand in ranked:
            if len(cards) >= self.cfg.max_cards:
                break
            if cand.kind == "precedent":
                card = self.builder.precedent_card(
                    cand.row,
                    confidence=cand.confidence,
                    reason=cand.reason,
                    query_text=str(cand.extra.get("query_text", "")),
                )
            else:
                card = self.builder.api_card(
                    cand.row,
                    confidence=cand.confidence,
                    reason=cand.reason,
                    display=cand.display,
                    active=cand.active,
                )
            if card is None:
                continue
            if card.qualname in pinned:
                card.pinned = True
            cards.append(card)
            self._remember(card, int(cand.row["id"]))
        self._queue_stale()
        return cards

    def _remember(self, card: Card, chunk_id: int) -> None:
        self.recent_cards[card.id] = (card.kind, chunk_id, card.qualname)
        self.recent_cards.move_to_end(card.id)
        while len(self.recent_cards) > 2000:
            self.recent_cards.popitem(last=False)

    def _queue_stale(self) -> None:
        assert self.builder is not None and self.pool is not None
        stale = self.builder.drain_stale()
        if not stale or self.loop is None:
            return
        conn = self.pool.get()
        with transaction(conn):
            conn.executemany(
                "DELETE FROM indexed_dists WHERE dist_name = ? AND dist_version = ?",
                sorted(stale),
            )
        log.info("re-indexing stale dists: %s", sorted(stale))
        self.loop.call_soon_threadsafe(self._start_sync)

    def _log_query(self, frame: ContextFrame, t0: float, n: int, abandoned: bool = False) -> None:
        if self.pool is None:
            return
        latency = round((time.perf_counter() - t0) * 1000, 2)
        try:
            lookups.log_events(
                self.pool.get(),
                [
                    Event(
                        ts=lookups.now_iso(),
                        type="query_served",
                        trigger=frame.trigger,
                        payload={
                            "latencyMs": latency,
                            "nCards": n,
                            "abandoned": abandoned,
                            "requestId": frame.request_id,
                        },
                    )
                ],
            )
        except Exception:
            log.debug("could not log query", exc_info=True)

    # ---------------------------------------------------------------- memory
    async def events_log(self, params: dict[str, Any] | None) -> None:
        if self.pool is None:
            return
        raw = (params or {}).get("events") or []
        events = []
        for e in raw:
            try:
                events.append(Event.model_validate(e))
            except ValidationError:
                continue
        if events:
            await asyncio.to_thread(lookups.log_events, self.pool.get(), events)

    def _pinned_qualnames(self) -> set[str]:
        assert self.pool is not None
        return {r[0] for r in lookups.pins(self.pool.get())}

    def _card_for_qualname(
        self, qualname: str, chunk_id: int | None, kind: str, reason: str
    ) -> Card | None:
        assert self.store is not None and self.builder is not None and self.resolver is not None
        row = self.store.chunk(chunk_id) if chunk_id else None
        if row is None or row["qualname"] != qualname:
            row = self.store.lookup(qualname)
        if row is None:
            return None
        display = self.resolver._display(row)
        card = self.builder.api_card(row, confidence=1.0, reason=reason, display=display, kind=kind)
        if card is not None:
            self._remember(card, int(row["id"]))
        return card

    def _frequent_cards(self) -> list[dict[str, Any]]:
        assert self.pool is not None
        conn = self.pool.get()
        pinned = self._pinned_qualnames()
        out = []
        for qualname, count in lookups.frequent_qualnames(conn, exclude=pinned):
            card = self._card_for_qualname(
                qualname, None, "frequent", f"Looked up {count}× in 14 days"
            )
            if card is not None:
                out.append(card.wire())
        return out

    async def memory_frequent(self, params: Any) -> list[dict[str, Any]]:
        self._require()
        return await asyncio.to_thread(self._frequent_cards)

    def _pinned_cards(self) -> list[dict[str, Any]]:
        assert self.pool is not None
        out = []
        for row in lookups.pins(self.pool.get()):
            card = self._card_for_qualname(row[0], row[1], "api", "Pinned")
            if card is not None:
                card.pinned = True
                out.append(card.wire())
        return out

    async def memory_pinned(self, params: Any) -> list[dict[str, Any]]:
        self._require()
        return await asyncio.to_thread(self._pinned_cards)

    def _resolve_card_id(self, card_id: str) -> tuple[str, int, str | None]:
        hit = self.recent_cards.get(card_id)
        if hit is None:
            raise RpcError(INVALID_PARAMS, f"unknown card id {card_id}")
        return hit

    async def memory_pin(self, params: dict[str, Any] | None) -> dict[str, Any]:
        self._require()
        _, chunk_id, qualname = self._resolve_card_id((params or {}).get("cardId", ""))
        if not qualname:
            raise RpcError(INVALID_PARAMS, "card has no qualified name to pin")
        assert self.pool is not None
        await asyncio.to_thread(lookups.pin, self.pool.get(), qualname, chunk_id)
        return {}

    async def memory_unpin(self, params: dict[str, Any] | None) -> dict[str, Any]:
        self._require()
        p = params or {}
        qualname = p.get("qualname")
        if not qualname:
            _, _, qualname = self._resolve_card_id(p.get("cardId", ""))
        assert self.pool is not None
        if qualname:
            await asyncio.to_thread(lookups.unpin, self.pool.get(), qualname)
        return {}

    async def metrics_report(self, params: dict[str, Any] | None) -> dict[str, Any]:
        self._require()
        since = int((params or {}).get("sinceDays", 14))
        assert self.pool is not None
        report = await asyncio.to_thread(build_report, self.pool.get(), since)
        return report.wire()

    async def source_read(self, params: dict[str, Any] | None) -> dict[str, Any]:
        """Text of a virtual source: a runtime-doc module or a file in git history."""
        store = self._require()
        p = params or {}
        path = p.get("path", "")
        if is_runtime_path(path):
            lines = await asyncio.to_thread(store.runtime_lines, path)
            if lines is None:
                raise RpcError(INVALID_PARAMS, f"unknown runtime source {path}")
            return {"text": "\n".join(lines), "languageId": "plaintext"}
        repo, commit = p.get("repo"), p.get("commit")
        if repo and commit:
            assert self.builder is not None
            rel = os.path.relpath(path, repo).replace(os.sep, "/")
            rev = f"{commit}^" if p.get("deleted") else commit
            lines = await asyncio.to_thread(self.builder.git.lines, repo, rev, rel)
            if lines is None:
                raise RpcError(INVALID_PARAMS, f"cannot read {rel} at {rev}")
            return {"text": "\n".join(lines), "languageId": "python"}
        raise RpcError(INVALID_PARAMS, "source/read needs a runtime path or repo+commit")

    async def ping(self, params: Any) -> dict[str, Any]:
        return {
            "serverVersion": SERVER_VERSION,
            "pid": os.getpid(),
            "python": sys.version.split()[0],
        }

    async def shutdown(self, params: Any) -> None:
        self._shutdown_workers()
        return None

    def _shutdown_workers(self) -> None:
        if self._mp_stop is not None:
            self._mp_stop.set()
        ex = self.executor
        self.executor = None
        if ex is not None:
            procs = list(getattr(ex, "_processes", {}).values())
            ex.shutdown(wait=False, cancel_futures=True)
            for p in procs:
                try:
                    p.terminate()
                except Exception:
                    pass

    async def exit(self, params: Any) -> None:
        self._shutdown_workers()
        self.stop.set()

    def close(self) -> None:
        self._shutdown_workers()
        if self.pool is not None:
            self.pool.close()
