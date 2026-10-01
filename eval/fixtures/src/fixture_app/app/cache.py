"""Caching helpers: an in-memory TTL cache and a small on-disk response cache."""

import hashlib
import json
import os
import time
from collections import OrderedDict


class Cache:
    """In-memory cache with a time-to-live and a size limit."""

    def __init__(self, ttl=300.0, max_items=256):
        """Create an empty cache."""
        self.ttl = ttl
        self.max_items = max_items
        self._items = OrderedDict()

    def get(self, key, default=None):
        """Return a live entry, or default if it is missing or expired."""
        entry = self._items.get(key)
        if entry is None:
            return default
        stored_at, value = entry
        if time.time() - stored_at > self.ttl:
            del self._items[key]
            return default
        self._items.move_to_end(key)
        return value

    def set(self, key, value):
        """Store a value, evicting the oldest entry when the cache is full."""
        self._items[key] = (time.time(), value)
        self._items.move_to_end(key)
        while len(self._items) > self.max_items:
            self._items.popitem(last=False)

    def purge(self):
        """Drop every expired entry and return how many were removed."""
        now = time.time()
        stale = [k for k, (stored_at, _) in self._items.items() if now - stored_at > self.ttl]
        for key in stale:
            del self._items[key]
        return len(stale)


def cache_key(url, params=None):
    """Build a stable cache key from a URL and its query parameters."""
    raw = url + "?" + json.dumps(params or {}, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def cache_path(cache_dir, key):
    """Return the file that holds a cache entry."""
    return os.path.join(cache_dir, key[:2], key + ".json")


def read_cache_entry(cache_dir, key, ttl=3600):
    """Return a cached value if its file is younger than ttl seconds."""
    path = cache_path(cache_dir, key)
    try:
        age = time.time() - os.path.getmtime(path)
    except OSError:
        return None
    if age > ttl:
        return None
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def write_cache_entry(cache_dir, key, value):
    """Store a JSON-serialisable value under the given key."""
    path = cache_path(cache_dir, key)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle)
    return path


def file_fingerprint(path, chunk_size=65536):
    """Return the md5 hex digest of a file, read in chunks."""
    digest = hashlib.md5()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(chunk_size), b""):
            digest.update(block)
    return digest.hexdigest()


def memoize(func):
    """Cache a function's results in memory, keyed by its positional arguments."""
    results = {}

    def wrapper(*args):
        """Look up or compute the result for these arguments."""
        if args not in results:
            results[args] = func(*args)
        return results[args]

    return wrapper
