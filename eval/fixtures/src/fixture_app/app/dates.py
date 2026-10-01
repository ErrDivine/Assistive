"""Date parsing, ranges and bucketing."""

from collections import defaultdict
from datetime import date, datetime, timedelta


def parse_iso_date(text):
    """Parse YYYY-MM-DD into a date."""
    return datetime.strptime(text, "%Y-%m-%d").date()


def parse_timestamp(value):
    """Parse an ISO-8601 timestamp, tolerating a trailing Z."""
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def days_between(start, end):
    """Number of whole days from start to end."""
    return (end - start).days


def date_range(start, end, step_days=1):
    """List every date from start to end inclusive."""
    days = []
    current = start
    while current <= end:
        days.append(current)
        current += timedelta(days=step_days)
    return days


def month_range(start, end):
    """List the first day of every month touched by start..end."""
    months = []
    year, month = start.year, start.month
    while (year, month) <= (end.year, end.month):
        months.append(date(year, month, 1))
        month += 1
        if month > 12:
            year, month = year + 1, 1
    return months


def week_start(day):
    """Return the Monday of the week containing day."""
    return day - timedelta(days=day.weekday())


def bucket_by_week(records, field="created"):
    """Group records into a dict keyed by the Monday of their week."""
    buckets = defaultdict(list)
    for record in records:
        buckets[week_start(record[field].date())].append(record)
    return dict(buckets)


def bucket_by_month(records, field="created"):
    """Group records into a dict keyed by 'YYYY-MM'."""
    buckets = defaultdict(list)
    for record in records:
        buckets[record[field].strftime("%Y-%m")].append(record)
    return dict(sorted(buckets.items()))


def count_per_day(timestamps):
    """Count how many timestamps fall on each calendar day."""
    counts: dict = {}
    for stamp in timestamps:
        key = stamp.date().isoformat()
        counts[key] = counts.get(key, 0) + 1
    return counts
