"""Geometry and number formatting utilities, unrelated to HTTP."""

import math


def distance(p, q):
    """Euclidean distance between two 2-D points."""
    return math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2)


def circle_area(radius):
    """Area of a circle."""
    return math.pi * radius ** 2


def polygon_area(points):
    """Shoelace-formula area of a simple polygon given as (x, y) tuples."""
    total = 0.0
    for i, (x1, y1) in enumerate(points):
        x2, y2 = points[(i + 1) % len(points)]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


def clamp(value, low, high):
    """Limit value to the closed interval [low, high]."""
    return max(low, min(high, value))


def mean(values):
    """Arithmetic mean of a non-empty sequence."""
    return sum(values) / len(values)


def format_money(cents, currency="USD"):
    """Format an integer number of cents as 1,234.56 USD."""
    return "{:,.2f} {}".format(cents / 100, currency)


def format_percent(part, whole, digits=1):
    """Format part/whole as a percentage string."""
    if not whole:
        return "n/a"
    return "%.*f%%" % (digits, 100.0 * part / whole)


def pad_columns(rows):
    """Left-justify table rows into aligned columns."""
    widths = [max(len(str(cell)) for cell in column) for column in zip(*rows)]
    return ["  ".join(str(cell).ljust(w) for cell, w in zip(row, widths)) for row in rows]
