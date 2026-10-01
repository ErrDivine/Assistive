"""Local embeddings (design plan §6, §9.4). No network at runtime (invariant I4).

``FastEmbedder`` loads a fastembed ONNX model from ``~/.reference-rail/models``
with ``local_files_only``. The model is fetched once by the explicit
``rail-server download-model`` command (the extension's "Download Embedding
Model" command runs it after asking). Without a model on disk, the
``HashingEmbedder`` (identifier sub-token feature hashing) keeps precedent
search working fully offline. DECISIONS.md D-006 records the trade-off.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import zlib
from pathlib import Path
from typing import Protocol

import numpy as np

log = logging.getLogger(__name__)

EMBED_BATCH = 64
MAX_EMBED_CHARS = 1500  # fits the 256-token window of the small models
HASH_DIM = 512


class Embedder(Protocol):
    name: str
    dim: int

    def embed(self, texts: list[str]) -> np.ndarray: ...


def _normalize(mat: np.ndarray) -> np.ndarray:
    mat = np.asarray(mat, dtype=np.float32)
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return mat / norms


_SPLIT = re.compile(r"[A-Za-z][a-z]+|[A-Z]+(?![a-z])|[0-9]+")
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_STOP = frozenset(
    "self cls the and for not none true false return def class if else elif in is of to a an"
    " import from as with try except finally raise pass lambda yield while break continue".split()
)


def hashing_features(text: str) -> dict[int, float]:
    feats: dict[int, float] = {}
    for m in _IDENT.finditer(text):
        tok = m.group(0)
        low = tok.lower()
        if low in _STOP:
            continue
        subs = [s.lower() for s in _SPLIT.findall(tok)]
        for piece, weight in [(low, 1.0)] + [(s, 0.6) for s in subs if s != low and len(s) > 1]:
            h = zlib.crc32(piece.encode("utf-8"))
            idx = h % HASH_DIM
            sign = 1.0 if (h >> 16) & 1 else -1.0
            feats[idx] = feats.get(idx, 0.0) + sign * weight
    return feats


class HashingEmbedder:
    """Deterministic, dependency-free fallback: signed feature hashing of identifiers."""

    name = "hashing-v1"
    dim = HASH_DIM

    def embed(self, texts: list[str]) -> np.ndarray:
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, text in enumerate(texts):
            for idx, val in hashing_features(text).items():
                out[i, idx] = val
        # sublinear damping keeps one repeated identifier from dominating
        out = np.sign(out) * np.log1p(np.abs(out))
        return _normalize(out)


def _model_description(model_name: str):  # type: ignore[no-untyped-def]
    from fastembed import TextEmbedding

    for desc in TextEmbedding._list_supported_models():
        if desc.model == model_name:
            return desc
    raise ValueError(f"fastembed does not support {model_name}")


def _gcs_dir(models_dir: Path, model_name: str, deprecated_tar: bool) -> Path:
    return models_dir / f"{'fast-' if deprecated_tar else ''}{model_name.split('/')[-1]}"


def local_model_path(models_dir: Path, model_name: str) -> Path | None:
    """Where a previously downloaded model sits, or None."""
    try:
        desc = _model_description(model_name)
    except Exception:
        return None
    gcs = _gcs_dir(models_dir, model_name, desc.sources.deprecated_tar_struct)
    if (gcs / desc.model_file).exists():
        return gcs
    hf = desc.sources.hf
    if hf:
        snap = models_dir / f"models--{hf.replace('/', '--')}" / "snapshots"
        if snap.is_dir():
            for d in sorted(snap.iterdir()):
                if (d / desc.model_file).exists():
                    return d
    return None


class FastEmbedder:
    def __init__(self, model_name: str, models_dir: Path, threads: int | None = None) -> None:
        from fastembed import TextEmbedding

        path = local_model_path(models_dir, model_name)
        if path is None:
            raise FileNotFoundError(f"embedding model {model_name} is not downloaded")
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        self._model = TextEmbedding(
            model_name,
            cache_dir=str(models_dir),
            threads=threads,
            specific_model_path=str(path),
            local_files_only=True,
        )
        self.name = f"fastembed:{model_name}"
        self.dim = int(_model_description(model_name).dim)
        self._lock = threading.Lock()

    def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        with self._lock:
            vecs = list(self._model.embed(texts, batch_size=EMBED_BATCH))
        return _normalize(np.stack(vecs))


def get_embedder(backend: str, model_name: str, models_dir: Path) -> Embedder:
    if backend == "hashing":
        return HashingEmbedder()
    try:
        return FastEmbedder(model_name, models_dir)
    except Exception as e:
        if backend == "fastembed":
            raise
        log.info("using hashing embedder (%s)", e)
        return HashingEmbedder()


def download_model(model_name: str, models_dir: Path) -> Path:
    """Fetch a fastembed model into ``models_dir``. The only networked code path
    besides the optional Phase 5 extractor; never called implicitly."""
    from fastembed import TextEmbedding
    from fastembed.common.model_management import ModelManagement

    models_dir.mkdir(parents=True, exist_ok=True)
    existing = local_model_path(models_dir, model_name)
    if existing:
        return existing
    desc = _model_description(model_name)
    try:
        TextEmbedding(model_name, cache_dir=str(models_dir))
    except Exception as e:  # e.g. HuggingFace unreachable behind a proxy
        if not desc.sources.url:
            raise
        log.info("HuggingFace download failed (%s); trying %s", e, desc.sources.url)
        ModelManagement.retrieve_model_gcs(
            desc.model,
            desc.sources.url,
            str(models_dir),
            deprecated_tar_struct=desc.sources.deprecated_tar_struct,
        )
    path = local_model_path(models_dir, model_name)
    if path is None:
        raise RuntimeError(f"download of {model_name} finished but no model file was found")
    return path


def embedding_text(
    qualname: str | None, signature: str | None, docstring: str | None, body: str | None
) -> str:
    parts = [qualname or "", signature or "", docstring or "", body or ""]
    return "\n".join(p for p in parts if p)[:MAX_EMBED_CHARS]


def to_blob(vec: np.ndarray) -> bytes:
    return np.asarray(vec, dtype=np.float16).tobytes()


def from_blob(blob: bytes, dim: int) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float16, count=dim)
