"""Retry and backoff helpers."""

import logging
import random
import time

from requests.exceptions import ConnectionError, Timeout

logger = logging.getLogger(__name__)


def backoff_delays(base=0.5, factor=2.0, count=5, cap=30.0):
    """Yield exponentially growing delays, capped at ``cap`` seconds."""
    delay = base
    for _ in range(count):
        yield min(delay, cap)
        delay *= factor


def jittered(delay, spread=0.25):
    """Randomise a delay by up to +/- spread so clients do not retry in lockstep."""
    return delay * (1 + random.uniform(-spread, spread))


def retry_with_backoff(func, attempts=3, base_delay=0.5, exceptions=(ConnectionError, Timeout)):
    """Call func until it succeeds, doubling the delay after each failure."""
    last_error = None
    for attempt in range(attempts):
        try:
            return func()
        except exceptions as exc:
            last_error = exc
            wait = base_delay * (2 ** attempt)
            logger.info("attempt %d failed (%s); sleeping %.1fs", attempt + 1, exc, wait)
            time.sleep(wait)
    raise last_error


def retry_on_status(session, method, url, statuses=(429, 502, 503), tries=4, **kwargs):
    """Repeat a request while the server answers with a retryable status code."""
    resp = None
    for delay in backoff_delays(count=tries):
        resp = session.request(method, url, timeout=10, **kwargs)
        if resp.status_code not in statuses:
            break
        retry_after = resp.headers.get("Retry-After")
        time.sleep(float(retry_after) if retry_after else jittered(delay))
    return resp


def wait_until(predicate, timeout=30.0, interval=1.0):
    """Poll predicate until it returns a truthy value or the timeout passes."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None
