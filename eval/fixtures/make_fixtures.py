"""Build the evaluation fixtures deterministically (design plan §13).

Creates, next to this file:

* ``.venv/``            a virtualenv with pinned ``requests`` and ``attrs``;
* ``fixture_app/``      a git repo with one commit of ``src/fixture_app``;
* ``fixture_history/``  a scripted git repo whose history contains near-duplicate,
                        renamed and deleted functions at known SHAs
                        (written to ``fixture_history.json``).

Commits use fixed author, committer and dates, so SHAs are identical on every
machine. Re-running is idempotent: existing outputs are rebuilt from scratch,
except the venv, which is reused when its pins already match.

Usage: python eval/fixtures/make_fixtures.py [--skip-venv]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "src"
VENV = HERE / ".venv"
APP = HERE / "fixture_app"
HISTORY = HERE / "fixture_history"
HISTORY_MANIFEST = HERE / "fixture_history.json"

PINS = [
    "requests==2.32.3",
    "attrs==24.2.0",
    # transitive pins, so the fixture index is identical everywhere
    "certifi==2026.7.22",
    "charset-normalizer==3.5.2",
    "idna==3.20",
    "urllib3==2.8.0",
]

GIT_ENV = {
    "GIT_AUTHOR_NAME": "Fixture Author",
    "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
    "GIT_COMMITTER_NAME": "Fixture Author",
    "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
}


def run(cmd: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    full_env = {**os.environ, **(env or {})}
    out = subprocess.run(cmd, cwd=cwd, env=full_env, check=True, capture_output=True, text=True)
    return out.stdout.strip()


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def build_venv() -> None:
    marker = VENV / "fixture-pins.txt"
    if marker.exists() and marker.read_text() == "\n".join(PINS) and venv_python().exists():
        print("venv: up to date")
        return
    shutil.rmtree(VENV, ignore_errors=True)
    uv = shutil.which("uv")
    if uv:
        run([uv, "venv", "--python", sys.executable, str(VENV)])
        run([uv, "pip", "install", "--python", str(venv_python()), *PINS])
    else:
        run([sys.executable, "-m", "venv", str(VENV)])
        run([str(venv_python()), "-m", "pip", "install", "--disable-pip-version-check", *PINS])
    marker.write_text("\n".join(PINS))
    print("venv: built with", ", ".join(PINS))


def git(repo: Path, *args: str, date: str | None = None) -> str:
    env = dict(GIT_ENV)
    if date:
        env["GIT_AUTHOR_DATE"] = date
        env["GIT_COMMITTER_DATE"] = date
    return run(["git", *args], cwd=repo, env=env)


def init_repo(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
    path.mkdir(parents=True)
    git(path, "init", "-q", "-b", "main")


def commit_all(repo: Path, message: str, date: str) -> str:
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "--no-gpg-sign", "-m", message, date=date)
    return git(repo, "rev-parse", "HEAD")


def build_app() -> None:
    init_repo(APP)
    shutil.copytree(SRC / "fixture_app", APP, dirs_exist_ok=True)
    sha = commit_all(APP, "Fixture app", "2024-01-15T10:00:00+00:00")
    print("fixture_app:", sha)


# -- fixture_history ---------------------------------------------------------

HISTORY_STEPS: list[tuple[str, str, dict[str, str | None]]] = [
    (
        "2024-02-01T09:00:00+00:00",
        "Add text utilities",
        {
            "textutil.py": '''\
"""Small text helpers."""

import re
import unicodedata


def slugify(title):
    """Turn a title into a URL slug."""
    value = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii")
    value = re.sub(r"[^\\w\\s-]", "", value).strip().lower()
    return re.sub(r"[-\\s]+", "-", value)


def truncate_words(text, limit):
    """Keep the first ``limit`` words of ``text``."""
    words = text.split()
    if len(words) <= limit:
        return text
    return " ".join(words[:limit]) + "..."


def parse_csv_line(line, sep=","):
    """Split one CSV line, honouring double quotes."""
    fields, current, quoted = [], [], False
    for ch in line:
        if ch == '"':
            quoted = not quoted
        elif ch == sep and not quoted:
            fields.append("".join(current))
            current = []
        else:
            current.append(ch)
    fields.append("".join(current))
    return fields
''',
        },
    ),
    (
        "2024-02-08T09:00:00+00:00",
        "Add retry helper and checksum",
        {
            "netutil.py": '''\
"""Networking helpers."""

import hashlib
import time


def retry_call(func, attempts=3, delay=0.5, exceptions=(OSError,)):
    """Call ``func`` until it succeeds, sleeping between failed attempts."""
    last_error = None
    for attempt in range(attempts):
        try:
            return func()
        except exceptions as exc:
            last_error = exc
            time.sleep(delay * (2 ** attempt))
    raise last_error


def file_checksum(path, chunk_size=65536):
    """SHA-256 of a file, read in chunks."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(chunk_size), b""):
            digest.update(block)
    return digest.hexdigest()
''',
        },
    ),
    (
        "2024-02-15T09:00:00+00:00",
        "Rename truncate_words to shorten_text",
        {
            "textutil.py": '''\
"""Small text helpers."""

import re
import unicodedata


def slugify(title):
    """Turn a title into a URL slug."""
    value = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii")
    value = re.sub(r"[^\\w\\s-]", "", value).strip().lower()
    return re.sub(r"[-\\s]+", "-", value)


def shorten_text(text, limit):
    """Keep the first ``limit`` words of ``text``."""
    words = text.split()
    if len(words) <= limit:
        return text
    return " ".join(words[:limit]) + "..."


def parse_csv_line(line, sep=","):
    """Split one CSV line, honouring double quotes."""
    fields, current, quoted = [], [], False
    for ch in line:
        if ch == '"':
            quoted = not quoted
        elif ch == sep and not quoted:
            fields.append("".join(current))
            current = []
        else:
            current.append(ch)
    fields.append("".join(current))
    return fields
''',
        },
    ),
    (
        "2024-02-22T09:00:00+00:00",
        "Drop hand-written CSV parsing in favour of the csv module",
        {
            "textutil.py": '''\
"""Small text helpers."""

import re
import unicodedata


def slugify(title):
    """Turn a title into a URL slug."""
    value = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii")
    value = re.sub(r"[^\\w\\s-]", "", value).strip().lower()
    return re.sub(r"[-\\s]+", "-", value)


def shorten_text(text, limit):
    """Keep the first ``limit`` words of ``text``."""
    words = text.split()
    if len(words) <= limit:
        return text
    return " ".join(words[:limit]) + "..."
''',
        },
    ),
    (
        "2024-03-01T09:00:00+00:00",
        "Remove retry helper; callers use the HTTP client's retries",
        {
            "netutil.py": '''\
"""Networking helpers."""

import hashlib


def file_checksum(path, chunk_size=65536):
    """SHA-256 of a file, read in chunks."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(chunk_size), b""):
            digest.update(block)
    return digest.hexdigest()
''',
        },
    ),
    (
        "2024-03-08T09:00:00+00:00",
        "Add a near-duplicate slug helper for tags",
        {
            "tags.py": '''\
"""Tag helpers."""

import re


def tag_slug(tag):
    """Lower-case a tag and join its words with dashes."""
    value = re.sub(r"[^\\w\\s-]", "", tag).strip().lower()
    return re.sub(r"[-\\s]+", "-", value)
''',
        },
    ),
]


def build_history() -> dict[str, object]:
    init_repo(HISTORY)
    commits = []
    for date, message, files in HISTORY_STEPS:
        for name, content in files.items():
            target = HISTORY / name
            if content is None:
                target.unlink(missing_ok=True)
            else:
                target.write_text(content, encoding="utf-8")
        sha = commit_all(HISTORY, message, date)
        commits.append({"sha": sha, "message": message, "date": date})
    manifest = {
        "commits": commits,
        # Functions deleted from the working tree, and the commit that deleted them.
        "deleted": [
            {"qualname": "textutil.parse_csv_line", "path": "textutil.py",
             "deleted_in": commits[3]["sha"]},
            {"qualname": "netutil.retry_call", "path": "netutil.py",
             "deleted_in": commits[4]["sha"]},
        ],
        # A rename is not a deletion: the function lives on under a new name.
        "renamed": [{"from": "textutil.truncate_words", "to": "textutil.shorten_text",
                     "in": commits[2]["sha"]}],
        "near_duplicates": [["textutil.slugify", "tags.tag_slug"]],
    }
    HISTORY_MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("fixture_history:", commits[-1]["sha"])
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-venv", action="store_true", help="do not build the venv")
    args = parser.parse_args()
    if not args.skip_venv:
        build_venv()
    build_app()
    build_history()
    return 0


if __name__ == "__main__":
    sys.exit(main())
