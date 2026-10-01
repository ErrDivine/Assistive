#!/usr/bin/env bash
# CI greps for invariants I1, I4 and I7 (design plan §2).
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0

# I1: the extension never modifies the user's buffers.
if grep -rnE '\.(edit|applyEdit|insertSnippet)\s*\(|WorkspaceEdit' extension/src; then
  echo "I1 violated: buffer-editing API used in extension/src (see above)." >&2
  fail=1
fi

# I4: no HTTP client in the server outside extract/grounded_llm.py.
if grep -rnE '^\s*(import|from)\s+(httpx|requests|aiohttp|urllib3|urllib\.request|http\.client)\b' \
    server/rail_server --include='*.py' | grep -v 'extract/grounded_llm.py'; then
  echo "I4 violated: HTTP client imported by rail-server (see above)." >&2
  fail=1
fi
if grep -nE '^\s*"(httpx|requests|aiohttp|urllib3)[=<>~ ]' server/pyproject.toml; then
  echo "I4 violated: HTTP client listed as a direct server dependency." >&2
  fail=1
fi

# I7: no telemetry upload code in the extension.
if grep -rnE '\bfetch\s*\(|XMLHttpRequest|https?\.request\s*\(|https?\.get\s*\(|\baxios\b|WebSocket\s*\(' extension/src; then
  echo "I7 violated: network call in the extension (see above)." >&2
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "invariants I1, I4, I7: ok"
fi
exit "$fail"
