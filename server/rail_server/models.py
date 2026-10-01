"""Wire schemas. These mirror ``extension/src/types.ts`` exactly (see design plan §7.2).

Field names are snake_case in Python and camelCase on the wire.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

Trigger = Literal["cursor_pause", "edit_pause", "diagnostic", "hover", "explicit"]
FactLabel = Literal["signature", "summary", "returns", "raises", "param", "note"]
FactOrigin = Literal["signature", "docstring", "source_scan", "runtime_doc"]
CardKind = Literal["api", "precedent", "frequent"]


class Wire(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")

    def wire(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, exclude_none=True)


class Position(Wire):
    line: int
    character: int


class SourceLoc(Wire):
    """A location as VS Code reports it: 0-based line and character."""

    path: str
    line: int
    character: int


class LineRange(Wire):
    start_line: int
    end_line: int


class SymbolAtCursor(Wire):
    text: str
    definition: SourceLoc | None = None
    hover_text: str | None = None


class RecentEdit(Wire):
    line: int
    text: str
    ts: float


class Diagnostic(Wire):
    message: str
    line: int
    source: str | None = None


class ContextFrame(Wire):
    request_id: int
    trigger: Trigger
    doc_uri: str
    language_id: str
    cursor: Position
    enclosing_text: str = ""
    enclosing_range: LineRange | None = None
    symbol_at_cursor: SymbolAtCursor | None = None
    nearby_definitions: list[SourceLoc] = Field(default_factory=list)
    recent_edits: list[RecentEdit] = Field(default_factory=list)
    diagnostics: list[Diagnostic] = Field(default_factory=list)
    explicit_question: str | None = None


class RuntimeInfo(Wire):
    python_version: str


class SourceRef(Wire):
    """A real file span, 1-based inclusive lines (invariant I2)."""

    path: str
    start_line: int
    end_line: int
    dist_name: str | None = None
    dist_version: str | None = None
    repo: str | None = None
    commit: str | None = None
    deleted: bool | None = None
    runtime: RuntimeInfo | None = None

    @model_validator(mode="after")
    def _check_span(self) -> SourceRef:
        if not self.path:
            raise ValueError("SourceRef.path is required")
        if self.start_line < 1 or self.end_line < self.start_line:
            raise ValueError(f"bad span {self.start_line}-{self.end_line}")
        return self


class Fact(Wire):
    label: FactLabel
    text: str
    origin: FactOrigin
    span: SourceRef

    @model_validator(mode="after")
    def _check_text(self) -> Fact:
        if not self.text.strip():
            raise ValueError("Fact.text must not be empty")
        return self


class Snippet(Wire):
    text: str
    start_line: int


class Card(Wire):
    id: str
    kind: CardKind
    title: str
    facts: list[Fact]
    snippet: Snippet | None = None
    source: SourceRef
    confidence: float = Field(ge=0.0, le=1.0)
    reason: str
    # Extensions to §7.2, recorded in DECISIONS.md (D-012).
    qualname: str | None = None
    stale: bool | None = None
    pinned: bool | None = None
    authored_at: str | None = None

    @model_validator(mode="after")
    def _check_facts(self) -> Card:
        # I2: a card must carry at least one sourced fact.
        if not self.facts:
            raise ValueError("Card must have at least one fact")
        return self


class QueryResult(Wire):
    request_id: int
    cards: list[Card]


class Event(Wire):
    ts: str
    type: str
    card_id: str | None = None
    qualname: str | None = None
    trigger: str | None = None
    payload: dict[str, Any] | None = None


class OpenRate(Wire):
    shown: int
    opened: int
    pinned: int
    dismissed: int
    open_rate: float


class MetricsReport(Wire):
    since_days: int
    generated_at: str
    active_hours: int
    external_lookups: int
    lookups_per_active_hour: float | None
    lookups_per_active_hour_rail_on: float | None = None
    lookups_per_active_hour_rail_off: float | None = None
    cards_shown: int
    cards_opened: int
    cards_pinned: int
    cards_dismissed: int
    by_kind: dict[str, OpenRate]
    latency_p50_ms: float | None
    latency_p95_ms: float | None
    queries: int
    empty_rate_by_trigger: dict[str, float]
