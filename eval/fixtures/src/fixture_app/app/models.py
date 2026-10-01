"""Data models for the records the app moves around."""

from datetime import datetime
from typing import List, Optional

import attr
from attrs import define, field, validators


def _lower(value):
    """Lower-case and strip a string value."""
    return value.strip().lower()


@define
class User:
    """A user account as returned by the API."""

    id: int = field(validator=validators.instance_of(int))
    name: str = field(validator=validators.min_len(1))
    email: str = field(converter=_lower, validator=validators.matches_re(r"[^@]+@[^@]+"))
    team: Optional[str] = field(default=None)
    roles: List[str] = field(factory=list)

    @classmethod
    def from_payload(cls, payload):
        """Build a User from one API payload dict."""
        return cls(
            id=payload["id"],
            name=payload["name"],
            email=payload["email"],
            team=payload.get("team"),
            roles=list(payload.get("roles", [])),
        )


@define(frozen=True)
class Order:
    """A customer order; immutable once created."""

    id: int = field()
    customer_id: int = field()
    total_cents: int = field(validator=[validators.instance_of(int), validators.ge(0)])
    status: str = field(default="open", validator=validators.in_(("open", "paid", "refunded", "cancelled")))
    placed_at: datetime = field(factory=datetime.utcnow)

    @classmethod
    def from_payload(cls, payload):
        """Build an Order from one API payload dict."""
        return cls(
            id=payload["id"],
            customer_id=payload["customer_id"],
            total_cents=int(round(payload["total"] * 100)),
            status=payload.get("status", "open"),
            placed_at=datetime.fromisoformat(payload["placed_at"]),
        )

    @property
    def total(self):
        """Order total in whole currency units."""
        return self.total_cents / 100


@attr.s
class LegacyEvent:
    """An analytics event, kept on the old attr.s API for compatibility."""

    name = attr.ib(validator=attr.validators.instance_of(str))
    payload = attr.ib(default=attr.Factory(dict))
    created = attr.ib(default=None)

    def to_record(self):
        """Flatten the event into a plain dict."""
        stamp = self.created.isoformat() if self.created else None
        return {"name": self.name, "created": stamp, **self.payload}
