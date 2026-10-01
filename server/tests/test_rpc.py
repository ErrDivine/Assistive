"""Framing and dispatch (design plan §8, §13)."""

from __future__ import annotations

import asyncio
import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from rail_server.rpc import (
    INTERNAL_ERROR,
    METHOD_NOT_FOUND,
    REQUEST_CANCELLED,
    Endpoint,
    FramingError,
    RpcError,
    encode_message,
    read_message,
)


def test_round_trip_and_unicode() -> None:
    msg = {"jsonrpc": "2.0", "id": 1, "method": "x", "params": {"s": "héllo → ✓"}}
    data = encode_message(msg)
    assert data.startswith(b"Content-Length: ")
    assert read_message(io.BytesIO(data)) == msg


def test_multiple_messages_and_extra_headers() -> None:
    a = encode_message({"jsonrpc": "2.0", "method": "a"})
    body = json.dumps({"jsonrpc": "2.0", "method": "b"}).encode()
    b = (
        b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n"
        + b"Content-Length: %d\r\n\r\n" % len(body)
        + body
    )
    fp = io.BytesIO(a + b)
    assert read_message(fp)["method"] == "a"
    assert read_message(fp)["method"] == "b"
    assert read_message(fp) is None


class Trickle(io.RawIOBase):
    """Delivers one byte per read, like a slow pipe."""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0

    def readable(self) -> bool:
        return True

    def readinto(self, b: bytearray) -> int:  # type: ignore[override]
        if self.pos >= len(self.data):
            return 0
        b[0] = self.data[self.pos]
        self.pos += 1
        return 1


def test_partial_reads() -> None:
    msg = {"jsonrpc": "2.0", "id": 7, "result": {"k": "v" * 100}}
    fp = io.BufferedReader(Trickle(encode_message(msg)), buffer_size=1)
    assert read_message(fp) == msg


@pytest.mark.parametrize(
    "raw",
    [
        b"Content-Length: 10\r\n\r\n{}",  # EOF inside body
        b"\r\n{}",  # no Content-Length
        b"Content-Length: abc\r\n\r\n",
        b"Content-Length: 5\r\n",  # EOF inside headers
        b"Garbage\r\n\r\n",
    ],
)
def test_framing_errors(raw: bytes) -> None:
    with pytest.raises(FramingError):
        read_message(io.BytesIO(raw))


def test_invalid_json_is_a_parse_error() -> None:
    with pytest.raises(RpcError):
        read_message(io.BytesIO(b"Content-Length: 3\r\n\r\n{x}"))


def _responses(out: io.BytesIO) -> list[dict]:
    out.seek(0)
    msgs = []
    while (m := read_message(out)) is not None:
        msgs.append(m)
    return msgs


def test_dispatch_request_notification_and_errors() -> None:
    out = io.BytesIO()
    ep = Endpoint(out)
    seen: list[object] = []

    @ep.request("add")
    async def add(params: dict) -> int:
        return params["a"] + params["b"]

    @ep.request("boom")
    def boom(params: object) -> None:
        raise ValueError("nope")

    @ep.notification("note")
    def note(params: object) -> None:
        seen.append(params)

    async def run() -> None:
        await ep.dispatch({"jsonrpc": "2.0", "id": 1, "method": "add", "params": {"a": 2, "b": 3}})
        await ep.dispatch({"jsonrpc": "2.0", "id": 2, "method": "missing"})
        await ep.dispatch({"jsonrpc": "2.0", "id": 3, "method": "boom"})
        await ep.dispatch({"jsonrpc": "2.0", "method": "note", "params": [1]})
        await asyncio.sleep(0.05)

    asyncio.run(run())
    by_id = {m["id"]: m for m in _responses(out)}
    assert by_id[1]["result"] == 5
    assert by_id[2]["error"]["code"] == METHOD_NOT_FOUND
    assert by_id[3]["error"]["code"] == INTERNAL_ERROR
    assert seen == [[1]]


def test_cancel_request() -> None:
    out = io.BytesIO()
    ep = Endpoint(out)

    @ep.request("slow")
    async def slow(params: object) -> str:
        await asyncio.sleep(5)
        return "late"

    async def run() -> None:
        await ep.dispatch({"jsonrpc": "2.0", "id": 9, "method": "slow"})
        await asyncio.sleep(0.01)
        await ep.dispatch({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": 9}})
        await asyncio.sleep(0.05)

    asyncio.run(run())
    [resp] = _responses(out)
    assert resp["id"] == 9 and resp["error"]["code"] == REQUEST_CANCELLED


def test_server_process_stdio_round_trip(tmp_path: Path) -> None:
    """The real entry point: initialize < 1 s, ping, shutdown/exit; stdout carries
    only framed protocol messages."""
    env = {**os.environ, "REFERENCE_RAIL_HOME": str(tmp_path), "RAIL_LOG": "WARNING"}
    proc = subprocess.Popen(
        [sys.executable, "-m", "rail_server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    assert proc.stdin and proc.stdout

    def send(msg: dict) -> None:
        proc.stdin.write(encode_message(msg))  # type: ignore[union-attr]
        proc.stdin.flush()  # type: ignore[union-attr]

    import time

    t0 = time.monotonic()
    send(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "workspaceRoots": [],
                "pythonPath": sys.executable,
                "config": {},
                "noAutoIndex": True,
            },
        }
    )
    init = read_message(proc.stdout)
    assert time.monotonic() - t0 < 5.0  # process start + import; the handler itself is < 1 s
    assert init and init["result"]["serverVersion"]
    send({"jsonrpc": "2.0", "id": 2, "method": "ping"})
    pong = read_message(proc.stdout)
    assert pong and pong["result"]["pid"] == proc.pid
    send({"jsonrpc": "2.0", "id": 3, "method": "shutdown"})
    assert read_message(proc.stdout)["id"] == 3  # type: ignore[index]
    send({"jsonrpc": "2.0", "method": "exit"})
    assert proc.wait(timeout=10) == 0
    assert proc.stdout.read() == b""
