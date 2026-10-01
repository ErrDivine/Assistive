"""Property test for invariant I3: every fact produced for every chunk of the
fixture index is verbatim in the span it cites."""

from __future__ import annotations

from conftest import needs_fixtures

from rail_server.cards.verify import verify_fact

pytestmark = needs_fixtures


def test_every_fact_in_fixture_index_verifies(indexed_server) -> None:  # type: ignore[no-untyped-def]
    builder = indexed_server.builder
    conn = indexed_server.pool.get()
    total = failed = 0
    failures = []
    for row in conn.execute("SELECT * FROM chunks"):
        facts = builder.api_facts(row)
        for fact in facts:
            total += 1
            if not verify_fact(fact, builder.load_lines):
                failed += 1
                if len(failures) < 10:
                    failures.append((row["qualname"], fact.label, fact.text[:80]))
    assert total > 10_000
    assert failed == 0, f"{failed}/{total} facts failed verification, e.g. {failures}"


def test_cards_only_carry_verified_facts(indexed_server) -> None:  # type: ignore[no-untyped-def]
    conn = indexed_server.pool.get()
    rows = conn.execute("SELECT * FROM chunks WHERE kind = 'api' LIMIT 3000").fetchall()
    builder = indexed_server.builder
    for row in rows:
        card = builder.api_card(row, confidence=1.0, reason="t")
        if card is None:
            continue
        assert card.facts, "a card without facts must be dropped"
        for fact in card.facts:
            assert fact.span.path  # I2
            assert verify_fact(fact, builder.load_lines)
