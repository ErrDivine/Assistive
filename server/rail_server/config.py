"""Server configuration. Everything lives under ``~/.reference-rail/`` (invariant I7)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

SERVER_VERSION = "0.1.0"

DEFAULT_EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"

# Cosine gates calibrated on eval/queries.jsonl so that precedent precision is
# at least 0.8 (eval/run_eval.py --calibrate; DECISIONS.md D-008). Keyed by the
# embedder's name, because each embedding space has its own cosine scale.
CALIBRATED_THRESHOLDS = {
    "hybrid0.5:fastembed:sentence-transformers/all-MiniLM-L6-v2": 0.51,
    "hashing-v1": 0.47,
}
FALLBACK_THRESHOLD = 0.6


def data_dir() -> Path:
    override = os.environ.get("REFERENCE_RAIL_HOME")
    return Path(override) if override else Path.home() / ".reference-rail"


@dataclass
class Config:
    max_cards: int = 3
    # None: use the calibrated value for the active embedder.
    precedent_threshold: float | None = None
    history_depth: int = 500
    extra_repos: list[str] = field(default_factory=list)
    embedding_model: str = DEFAULT_EMBEDDING_MODEL
    # "auto": hybrid (identifier hashing + the fastembed model) when the model
    # is on disk, else hashing alone. "hybrid", "fastembed" and "hashing" force
    # one (DECISIONS.md D-006).
    embedding_backend: str = "auto"
    index_stdlib: bool = True
    index_history: bool = True
    data_dir: Path = field(default_factory=data_dir)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "index.sqlite"

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @classmethod
    def from_client(cls, raw: dict[str, Any] | None) -> Config:
        """Build from the ``config`` object in ``initialize`` (camelCase keys)."""
        cfg = cls()
        if not raw:
            return cfg
        names = {f.name for f in fields(cls)}
        for key, value in raw.items():
            snake = "".join("_" + c.lower() if c.isupper() else c for c in key)
            if snake not in names or value is None:
                continue
            if snake == "data_dir":
                value = Path(value).expanduser()
            setattr(cfg, snake, value)
        cfg.max_cards = max(1, min(int(cfg.max_cards), 10))
        cfg.history_depth = max(0, int(cfg.history_depth))
        if cfg.precedent_threshold is not None:
            cfg.precedent_threshold = float(cfg.precedent_threshold)
        cfg.extra_repos = [str(Path(p).expanduser()) for p in cfg.extra_repos]
        return cfg

    def threshold_for(self, embedder_name: str | None) -> float:
        if self.precedent_threshold is not None:
            return self.precedent_threshold
        return CALIBRATED_THRESHOLDS.get(embedder_name or "", FALLBACK_THRESHOLD)

    def to_worker(self) -> dict[str, Any]:
        """Picklable form for the indexing process."""
        return {
            "db_path": str(self.db_path),
            "models_dir": str(self.models_dir),
            "embedding_model": self.embedding_model,
            "embedding_backend": self.embedding_backend,
            "history_depth": self.history_depth,
            "index_stdlib": self.index_stdlib,
        }
