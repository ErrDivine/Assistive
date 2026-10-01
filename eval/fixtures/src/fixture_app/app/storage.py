"""Small helpers for reading and writing JSON, CSV and text files."""

import csv
import json
import os
from csv import DictReader, DictWriter
from pathlib import Path


def load_json(path, default=None):
    """Read a JSON file, returning default when it does not exist."""
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def save_json(path, data, indent=2):
    """Write data as pretty JSON, creating parent directories."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=indent, sort_keys=True)
        handle.write("\n")


def load_jsonl(path):
    """Read a JSON-lines file into a list of records."""
    records = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def append_jsonl(path, record):
    """Append one record to a JSON-lines file."""
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def load_csv_rows(path, delimiter=","):
    """Read a CSV file into a list of dicts keyed by the header row."""
    with open(path, newline="", encoding="utf-8") as handle:
        return list(DictReader(handle, delimiter=delimiter))


def save_csv_rows(path, rows, fieldnames):
    """Write dict rows to a CSV file with the given column order."""
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def csv_column(path, column):
    """Return one column of a CSV file as a list of strings."""
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        header = next(reader)
        index = header.index(column)
        return [row[index] for row in reader]


def load_lines(path):
    """Read a text file into a list of non-empty stripped lines."""
    text = Path(path).read_text(encoding="utf-8")
    return [line.strip() for line in text.splitlines() if line.strip()]


def write_text_atomic(path, text):
    """Write text to a temp file and rename it over the target."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, target)
