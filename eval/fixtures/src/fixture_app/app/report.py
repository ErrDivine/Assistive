"""Aggregate fetched records into small reports."""

from collections import Counter, defaultdict, deque

from app.shapes import format_money, pad_columns
from app.textutil import normalize_whitespace


def count_by(records, key):
    """Count records by the value of one key."""
    return Counter(record[key] for record in records)


def top_n(counter: Counter, n=5):
    """Return the n most common (value, count) pairs."""
    return counter.most_common(n)


def group_orders_by_customer(orders):
    """Group orders by customer id."""
    groups = {}
    for order in orders:
        groups.setdefault(order.customer_id, []).append(order)
    return groups


def revenue_by_status(orders):
    """Sum order totals per status."""
    totals = defaultdict(int)
    for order in orders:
        totals[order.status] += order.total_cents
    return dict(totals)


def recent_window(values, size=7):
    """Keep the latest values in a moving window."""
    window = deque(maxlen=size)
    for value in values:
        window.append(value)
    return list(window)


def sort_users(users):
    """Return users ordered by name."""
    ordered: list = list(users)
    ordered.sort(key=lambda user: user.name)
    return ordered


def render_order_table(orders):
    """Render orders as an aligned text table."""
    rows = [("id", "customer", "status", "total")]
    for order in orders:
        rows.append((order.id, order.customer_id, order.status, format_money(order.total_cents)))
    return "\n".join(pad_columns(rows))


def describe_users(users):
    """Return a one-line summary of a user list."""
    names = sorted(user.name for user in users)
    return normalize_whitespace(", ".join(names) or "nobody")


def parse_pairs(text: str):
    """Parse 'a=1;b=2' style strings into a dict of strings."""
    pairs = {}
    for chunk in text.split(";"):
        key, _, value = chunk.partition("=")
        pairs[key.strip()] = value.strip()
    return pairs
