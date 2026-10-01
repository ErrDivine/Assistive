"""Text normalisation helpers."""

import re
import unicodedata

_WS = re.compile(r"\s+")
_CAMEL_1 = re.compile(r"(.)([A-Z][a-z]+)")
_CAMEL_2 = re.compile(r"([a-z0-9])([A-Z])")


def slugify(title):
    """Turn a title into a lowercase URL slug."""
    value = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii")
    value = re.sub(r"[^\w\s-]", "", value).strip().lower()
    return re.sub(r"[-\s]+", "-", value)


def slugify_filename(name, max_length=80):
    """Make a safe file name: slug the stem and keep the extension."""
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    slug = slugify(stem)[:max_length] or "untitled"
    return slug + ("." + ext.lower() if ext else "")


def normalize_whitespace(text):
    """Collapse runs of whitespace into single spaces and trim the ends."""
    return _WS.sub(" ", text).strip()


def camel_to_snake(name):
    """Convert CamelCase to snake_case."""
    step = _CAMEL_1.sub(r"\1_\2", name)
    return _CAMEL_2.sub(r"\1_\2", step).lower()


def strip_html_tags(html):
    """Remove tags and decode the few entities the API emits."""
    text = re.sub(r"<[^>]+>", " ", html)
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    return normalize_whitespace(text)


def normalize_email(address):
    """Lower-case an email address and drop +tag suffixes."""
    local, _, domain = address.strip().lower().partition("@")
    return local.split("+")[0] + "@" + domain


def truncate_words(text, limit=20, suffix="..."):
    """Keep the first ``limit`` words of text."""
    words = text.split()
    if len(words) <= limit:
        return text
    return " ".join(words[:limit]) + suffix


def is_internal(address: str):
    """True for addresses that belong to the company."""
    return address.startswith("ops-") or address.endswith("@corp.example")
