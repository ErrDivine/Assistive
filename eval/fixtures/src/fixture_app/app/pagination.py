"""Pagination loops for the different styles of list endpoint."""


def paginate_pages(session, url, page_size=100, max_pages=50):
    """Collect items from an endpoint that uses ?page=N numbering."""
    items = []
    page = 1
    while page <= max_pages:
        resp = session.get(url, params={"page": page, "per_page": page_size}, timeout=10)
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        items.extend(batch)
        page += 1
    return items


def paginate_cursor(session, url, limit=200):
    """Collect items from an endpoint that hands out next_cursor tokens."""
    items = []
    cursor = None
    while True:
        params = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        resp = session.get(url, params=params, timeout=10)
        resp.raise_for_status()
        body = resp.json()
        items.extend(body["data"])
        cursor = body.get("next_cursor")
        if not cursor:
            return items


def paginate_offset(session, url, page_size=50):
    """Collect items from an endpoint that takes offset/limit and reports a total."""
    items = []
    offset = 0
    total = None
    while total is None or offset < total:
        resp = session.get(url, params={"offset": offset, "limit": page_size}, timeout=10)
        resp.raise_for_status()
        body = resp.json()
        total = body["total"]
        items.extend(body["results"])
        offset += page_size
    return items


def paginate_link_header(session, url):
    """Follow rel="next" Link headers until the last page."""
    items = []
    next_url = url
    while next_url:
        resp = session.get(next_url, timeout=10)
        resp.raise_for_status()
        items.extend(resp.json())
        next_url = resp.links.get("next", {}).get("url")
    return items
