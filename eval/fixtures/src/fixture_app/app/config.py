"""Application settings, loaded from the environment with sane defaults."""

import os
import os.path

import attrs
from attrs import validators


def _positive(instance, attribute, value):
    """Reject zero or negative numbers."""
    if value <= 0:
        raise ValueError("%s must be positive, got %r" % (attribute.name, value))


@attrs.define
class Settings:
    """Runtime configuration for the CLI and the HTTP client."""

    base_url: str = attrs.field(validator=validators.instance_of(str))
    timeout: float = attrs.field(default=10.0, validator=[validators.instance_of(float), _positive])
    retries: int = attrs.field(default=3, validator=validators.instance_of(int))
    cache_dir: str = attrs.field(default=".cache")
    token: str = attrs.field(default="", repr=False)
    user_agent: str = attrs.field(default="fixture-app/0.3")


def load_settings_from_env(prefix="FIXTURE_"):
    """Build Settings from FIXTURE_* environment variables."""
    base_url = os.environ.get(prefix + "BASE_URL", "https://api.example.test")
    timeout = float(os.environ.get(prefix + "TIMEOUT", "10"))
    retries = int(os.getenv(prefix + "RETRIES", "3"))
    return Settings(
        base_url=base_url.rstrip("/"),
        timeout=timeout,
        retries=retries,
        cache_dir=os.path.expanduser(os.getenv(prefix + "CACHE_DIR", "~/.cache/fixture")),
        token=os.getenv(prefix + "TOKEN", ""),
    )


def settings_path(name, root=None):
    """Return the path of a named settings file under the config root."""
    root = root or os.path.join(os.path.expanduser("~"), ".config", "fixture")
    return os.path.join(root, name + ".json")


def auth_headers(settings):
    """Build request headers carrying the bearer token, when one is set."""
    headers = {"User-Agent": settings.user_agent, "Accept": "application/json"}
    if settings.token:
        headers["Authorization"] = "Bearer " + settings.token
    return headers


def with_timeout(settings, timeout):
    """Return a copy of the settings with a different timeout."""
    return attrs.evolve(settings, timeout=timeout)


def settings_to_dict(settings):
    """Serialise settings for logging, leaving the token out."""
    return attrs.asdict(settings, filter=lambda attribute, value: attribute.name != "token")
