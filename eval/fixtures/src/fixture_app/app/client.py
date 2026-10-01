"""HTTP client helpers built on requests."""

import logging

import requests
from requests import Response, Session
from requests.adapters import HTTPAdapter

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 10


def make_session(user_agent="fixture-app/0.3", pool_size=10):
    """Create a Session with a pooled adapter and a User-Agent header."""
    session = requests.Session()
    adapter = HTTPAdapter(pool_connections=pool_size, pool_maxsize=pool_size)
    session.mount("https://", adapter)
    session.headers.update({"User-Agent": user_agent})
    return session


def fetch_users(session: Session, base_url: str, team: str):
    """Return the list of users on a team."""
    resp = session.get("%s/teams/%s/users" % (base_url, team), timeout=DEFAULT_TIMEOUT)
    resp.raise_for_status()
    return resp.json()["users"]


def fetch_orders(session: Session, base_url, customer_id, status="open", limit=50):
    """Return a customer's orders filtered by status."""
    url = f"{base_url}/customers/{customer_id}/orders"
    resp = session.get(url, params={"status": status, "limit": limit}, timeout=DEFAULT_TIMEOUT)
    resp.raise_for_status()
    payload = resp.json()
    return payload["orders"]


def fetch_repo_stars(session, owner, repo):
    """Return the stargazer count of a GitHub repository."""
    url = "https://api.github.com/repos/{}/{}".format(owner, repo)
    resp = session.get(url, headers={"Accept": "application/vnd.github+json"}, timeout=DEFAULT_TIMEOUT)
    resp.raise_for_status()
    return resp.json()["stargazers_count"]


def fetch_weather(session, city, api_key, units="metric"):
    """Return the current temperature for a city."""
    params = {"q": city, "units": units, "appid": api_key}
    resp = session.get("https://api.weather.example/v2/current", params=params, timeout=5)
    resp.raise_for_status()
    main = resp.json().get("main", {})
    return main.get("temp")


def fetch_exchange_rate(session, base, quote):
    """Return the exchange rate from the base to the quote currency."""
    resp = session.get("https://rates.example/latest", params={"base": base, "symbols": quote}, timeout=5)
    resp.raise_for_status()
    rates = resp.json()["rates"]
    return rates[quote]


def fetch_status_page(url):
    """Return the overall status indicator of a hosted status page."""
    resp = requests.get(url + "/api/v2/status.json", timeout=DEFAULT_TIMEOUT)
    resp.raise_for_status()
    return resp.json()["status"]["indicator"]


def post_event(session, base_url, name, payload):
    """Send an analytics event and return the id assigned to it."""
    body = {"name": name, "payload": payload}
    resp = session.post(base_url + "/events", json=body, timeout=DEFAULT_TIMEOUT)
    resp.raise_for_status()
    return resp.json()["id"]


def post_feedback(session, base_url, user_id, message, rating=None):
    """Submit user feedback as a form and return the ticket number."""
    data = {"user": user_id, "message": message}
    if rating is not None:
        data["rating"] = rating
    resp = session.post(f"{base_url}/feedback", data=data, timeout=DEFAULT_TIMEOUT)
    resp.raise_for_status()
    return resp.json()["ticket"]


def post_webhook(url, payload, secret=""):
    """Deliver a webhook payload without a session; True when accepted."""
    headers = {"X-Signature": secret} if secret else {}
    resp = requests.post(url, json=payload, headers=headers, timeout=5)
    return resp.status_code == 202


def safe_fetch_json(url, params=None):
    """GET a URL and return its JSON body, or None when the request fails."""
    try:
        resp = requests.get(url, params=params, timeout=DEFAULT_TIMEOUT)
        resp.raise_for_status()
        return resp.json()
    except requests.HTTPError as exc:
        logger.warning("GET %s failed with %s", url, exc.response.status_code)
    except requests.Timeout:
        logger.warning("GET %s timed out", url)
    return None


def describe_response(resp: Response):
    """Summarise a response for log lines."""
    state = "ok" if resp.ok else "error"
    return "%s %s (%d bytes)" % (state, resp.status_code, len(resp.content))


def summarize_response(resp):
    """Return the status code and parsed body of an unannotated response."""
    resp.raise_for_status()
    return resp.status_code, resp.json()
