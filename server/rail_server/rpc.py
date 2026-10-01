"""JSON-RPC 2.0 over stdio with LSP-style ``Content-Length`` framing (design plan §8).

stdout carries the protocol, so nothing else may write to it. Logs go to stderr.

Reading happens on a dedicated thread (blocking reads work the same on every
platform); each parsed message is handed to the asyncio loop. Requests run as
tasks so that ``$/cancelRequest`` can cancel them.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import threading
from collections.abc import Awaitable, Callable
from typing import Any, BinaryIO

log = logging.getLogger(__name__)

# JSON-RPC / LSP error codes.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
REQUEST_CANCELLED = -32800

MAX_HEADER_BYTES = 8 * 1024
MAX_BODY_BYTES = 64 * 1024 * 1024


class FramingError(Exception):
    pass


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def encode_message(obj: dict[str, Any]) -> bytes:
    body = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return b"Content-Length: %d\r\n\r\n" % len(body) + body


def read_message(fp: BinaryIO) -> dict[str, Any] | None:
    """Read one framed message. Returns None on a clean EOF before any header."""
    content_length: int | None = None
    header_bytes = 0
    saw_any = False
    while True:
        line = fp.readline(MAX_HEADER_BYTES + 1)
        if not line:
            if saw_any:
                raise FramingError("EOF inside header block")
            return None
        saw_any = True
        header_bytes += len(line)
        if header_bytes > MAX_HEADER_BYTES:
            raise FramingError("header block too large")
        if line in (b"\r\n", b"\n"):
            if content_length is None:
                raise FramingError("missing Content-Length header")
            break
        try:
            name, _, value = line.decode("ascii").partition(":")
        except UnicodeDecodeError as e:
            raise FramingError("non-ASCII header") from e
        if not _:
            raise FramingError(f"malformed header line: {line!r}")
        if name.strip().lower() == "content-length":
            try:
                content_length = int(value.strip())
            except ValueError as e:
                raise FramingError(f"bad Content-Length: {value!r}") from e
            if content_length < 0 or content_length > MAX_BODY_BYTES:
                raise FramingError(f"Content-Length out of range: {content_length}")
        # Other headers (Content-Type) are accepted and ignored.
    body = b""
    while len(body) < content_length:
        chunk = fp.read(content_length - len(body))
        if not chunk:
            raise FramingError("EOF inside message body")
        body += chunk
    try:
        msg = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise RpcError(PARSE_ERROR, f"invalid JSON: {e}") from e
    if not isinstance(msg, dict):
        raise RpcError(INVALID_REQUEST, "message must be a JSON object")
    return msg


Handler = Callable[[Any], Awaitable[Any] | Any]


class Endpoint:
    """Dispatches requests and notifications; writes responses and server notifications."""

    def __init__(self, out: BinaryIO) -> None:
        self._out = out
        self._write_lock = threading.Lock()
        self._requests: dict[str, Handler] = {}
        self._notifications: dict[str, Handler] = {}
        self._inflight: dict[Any, asyncio.Task[Any]] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    # -- registration -----------------------------------------------------
    def request(self, method: str) -> Callable[[Handler], Handler]:
        def deco(fn: Handler) -> Handler:
            self._requests[method] = fn
            return fn

        return deco

    def notification(self, method: str) -> Callable[[Handler], Handler]:
        def deco(fn: Handler) -> Handler:
            self._notifications[method] = fn
            return fn

        return deco

    # -- output -----------------------------------------------------------
    def _write(self, obj: dict[str, Any]) -> None:
        data = encode_message(obj)
        with self._write_lock:
            self._out.write(data)
            self._out.flush()

    def notify(self, method: str, params: Any) -> None:
        """Send a server → client notification. Safe to call from any thread."""
        try:
            self._write({"jsonrpc": "2.0", "method": method, "params": params})
        except (BrokenPipeError, ValueError, OSError):
            log.debug("notify(%s) failed: client gone", method)

    # -- dispatch ---------------------------------------------------------
    async def dispatch(self, msg: dict[str, Any]) -> None:
        method = msg.get("method")
        if method is None:
            return  # a response to a server→client request; we send none
        if "id" in msg:
            msg_id = msg["id"]
            task = asyncio.ensure_future(self._run_request(msg_id, method, msg.get("params")))
            self._inflight[msg_id] = task

            def _forget(_t: asyncio.Future[Any], i: Any = msg_id) -> None:
                self._inflight.pop(i, None)

            task.add_done_callback(_forget)
            return
        if method == "$/cancelRequest":
            params = msg.get("params") or {}
            pending = self._inflight.get(params.get("id"))
            if pending is not None and not pending.done():
                pending.cancel()
            return
        handler = self._notifications.get(method)
        if handler is None:
            if not method.startswith("$/"):
                log.warning("unhandled notification %s", method)
            return
        try:
            result = handler(msg.get("params"))
            if inspect.isawaitable(result):
                await result
        except Exception:
            log.exception("notification %s failed", method)

    async def _run_request(self, msg_id: Any, method: str, params: Any) -> None:
        handler = self._requests.get(method)
        try:
            if handler is None:
                raise RpcError(METHOD_NOT_FOUND, f"method not found: {method}")
            result = handler(params)
            if inspect.isawaitable(result):
                result = await result
            self._write({"jsonrpc": "2.0", "id": msg_id, "result": result})
        except asyncio.CancelledError:
            self._write_error(msg_id, REQUEST_CANCELLED, "request cancelled")
        except RpcError as e:
            self._write_error(msg_id, e.code, e.message, e.data)
        except Exception as e:  # noqa: BLE001 - report, never crash the loop
            log.exception("request %s failed", method)
            self._write_error(msg_id, INTERNAL_ERROR, f"{type(e).__name__}: {e}")

    def _write_error(self, msg_id: Any, code: int, message: str, data: Any = None) -> None:
        err: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            err["data"] = data
        try:
            self._write({"jsonrpc": "2.0", "id": msg_id, "error": err})
        except (BrokenPipeError, ValueError, OSError):
            pass

    # -- main loop --------------------------------------------------------
    async def serve(self, inp: BinaryIO, stop: asyncio.Event) -> None:
        """Read messages from ``inp`` on a thread until EOF or ``stop`` is set."""
        loop = asyncio.get_running_loop()
        self._loop = loop
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

        def reader() -> None:
            while True:
                try:
                    msg = read_message(inp)
                except RpcError as e:
                    self._write_error(None, e.code, e.message)
                    continue
                except (FramingError, OSError, ValueError) as e:
                    log.error("framing error, closing: %s", e)
                    msg = None
                loop.call_soon_threadsafe(queue.put_nowait, msg)
                if msg is None:
                    return

        threading.Thread(target=reader, name="rpc-reader", daemon=True).start()
        while not stop.is_set():
            getter = asyncio.ensure_future(queue.get())
            stopper = asyncio.ensure_future(stop.wait())
            done, _ = await asyncio.wait({getter, stopper}, return_when=asyncio.FIRST_COMPLETED)
            if getter not in done:
                getter.cancel()
                break
            stopper.cancel()
            msg = getter.result()
            if msg is None:
                break
            await self.dispatch(msg)
        for task in list(self._inflight.values()):
            task.cancel()
