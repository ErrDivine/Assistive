"""Entry point: ``python -m rail_server`` speaks JSON-RPC on stdio.

Subcommands for humans and scripts:

* ``download-model [--model NAME]``: fetch the embedding model (needs network).
* ``probe [--python PATH]``: print the environment probe JSON.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys

from .config import SERVER_VERSION, Config
from .store.db import Fts5Unavailable, check_fts5


def _protect_stdio() -> tuple[int, int]:
    """Keep the protocol streams to ourselves.

    fd 1 is moved to a private descriptor and fd 1 is pointed at stderr, so a
    stray print or a child process can never corrupt the protocol. fd 0 gets
    the same treatment (children read /dev/null).
    """
    proto_in = os.dup(0)
    proto_out = os.dup(1)
    os.dup2(2, 1)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    sys.stdout = sys.stderr
    return proto_in, proto_out


def serve() -> int:
    from .rpc import Endpoint
    from .server import RailServer

    try:
        check_fts5()
    except Fts5Unavailable as e:
        print(f"rail-server: {e}", file=sys.stderr)
        return 3
    proto_in, proto_out = _protect_stdio()
    inp = os.fdopen(proto_in, "rb", buffering=0)
    out = os.fdopen(proto_out, "wb", buffering=0)
    endpoint = Endpoint(out)
    server = RailServer(endpoint)

    async def main() -> None:
        try:
            await endpoint.serve(inp, server.stop)
        finally:
            server.close()

    logging.getLogger("rail_server").info(
        "rail-server %s starting (pid %d)", SERVER_VERSION, os.getpid()
    )
    asyncio.run(main())
    return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=os.environ.get("RAIL_LOG", "INFO").upper(),
        format="[rail-server] %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    parser = argparse.ArgumentParser(prog="rail-server")
    parser.add_argument("--version", action="version", version=SERVER_VERSION)
    sub = parser.add_subparsers(dest="cmd")
    dl = sub.add_parser("download-model", help="download the local embedding model")
    dl.add_argument("--model", default=Config().embedding_model)
    pr = sub.add_parser("probe", help="print the environment probe for an interpreter")
    pr.add_argument("--python", default=sys.executable)
    args = parser.parse_args(argv)

    if args.cmd == "download-model":
        from .index.embeddings import download_model

        path = download_model(args.model, Config().models_dir)
        print(f"model ready at {path}", file=sys.stderr)
        return 0
    if args.cmd == "probe":
        import subprocess

        from .server import PROBE_SCRIPT

        return subprocess.call([args.python, str(PROBE_SCRIPT)])
    return serve()


if __name__ == "__main__":
    sys.exit(main())
