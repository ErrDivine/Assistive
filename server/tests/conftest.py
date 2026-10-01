"""Shared fixtures. With RAIL_NO_NETWORK=1 every non-loopback connection fails (I4)."""

from __future__ import annotations

import io
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "eval" / "fixtures"
FIXTURE_APP = FIXTURES / "fixture_app"
FIXTURE_HISTORY = FIXTURES / "fixture_history"
STUBS = FIXTURES / "src" / "stubs"


def _venv_python() -> Path:
    sub = "Scripts/python.exe" if os.name == "nt" else "bin/python"
    return FIXTURES / ".venv" / sub


FIXTURE_PYTHON = _venv_python()

_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def _guard_network() -> None:
    real_connect = socket.socket.connect

    def connect(self: socket.socket, address: object) -> object:
        host = address[0] if isinstance(address, tuple) else address
        if self.family in (socket.AF_INET, socket.AF_INET6) and host not in _LOOPBACK:
            raise OSError(f"network disabled in tests (RAIL_NO_NETWORK): {address!r}")
        return real_connect(self, address)  # type: ignore[arg-type]

    socket.socket.connect = connect  # type: ignore[method-assign]


if os.environ.get("RAIL_NO_NETWORK") == "1":
    _guard_network()


def fixtures_built() -> bool:
    return FIXTURE_PYTHON.exists() and FIXTURE_APP.exists() and FIXTURE_HISTORY.exists()


needs_fixtures = pytest.mark.skipif(
    not fixtures_built(), reason="run eval/fixtures/make_fixtures.py first"
)


@pytest.fixture(scope="session")
def probe() -> dict:
    if not fixtures_built():
        pytest.skip("run eval/fixtures/make_fixtures.py first")
    from rail_server.server import PROBE_SCRIPT

    out = subprocess.run(
        [str(FIXTURE_PYTHON), str(PROBE_SCRIPT)], capture_output=True, check=True, timeout=120
    )
    return json.loads(out.stdout)


@pytest.fixture(scope="session")
def rail_home(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return tmp_path_factory.mktemp("rail-home")


@pytest.fixture(scope="session")
def indexed_server(probe: dict, rail_home: Path):  # type: ignore[no-untyped-def]
    """A RailServer over a fully built fixture index (libraries, stdlib,
    fixture_app, fixture_history), with the deterministic hashing embedder."""
    import asyncio

    from rail_server.index import worker
    from rail_server.rpc import Endpoint
    from rail_server.server import RailServer

    os.environ["REFERENCE_RAIL_HOME"] = str(rail_home)
    server = RailServer(Endpoint(io.BytesIO()))
    config = {
        "embeddingBackend": "hashing",
        "extraRepos": [str(FIXTURE_HISTORY)],
        "dataDir": str(rail_home),
    }

    async def init() -> None:
        await server.initialize(
            {
                "workspaceRoots": [str(FIXTURE_APP)],
                "pythonPath": str(FIXTURE_PYTHON),
                "config": config,
                "noAutoIndex": True,
            }
        )

    asyncio.run(init())
    server._set_probe(probe)
    worker.run_sync(
        server.cfg.to_worker(), probe, [str(FIXTURE_APP)], [str(FIXTURE_HISTORY)], history=True
    )
    server._load_embedder_and_vectors()
    yield server
    server.close()


def frame(**kw: object) -> dict:
    base: dict = {
        "requestId": 1,
        "trigger": "cursor_pause",
        "docUri": "file:///nonexistent.py",
        "languageId": "python",
        "cursor": {"line": 0, "character": 0},
        "enclosingText": "",
        "nearbyDefinitions": [],
        "recentEdits": [],
        "diagnostics": [],
    }
    base.update(kw)
    return base


sys.path.insert(0, str(REPO / "eval"))
