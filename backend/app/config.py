"""Environment configuration, validated once at startup."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

DEFAULT_MODEL = "gemini-3.8-live"
DEFAULT_VOICE = "Kore"
# The SDKs only support ephemeral tokens on v1alpha at the moment.
DEFAULT_API_VERSION = "v1alpha"
DEFAULT_SYSTEM_INSTRUCTION = (
    "You are a friendly, concise voice assistant. Keep answers short and "
    "conversational, because they are spoken aloud. If you did not understand "
    "the user, ask them to repeat."
)
PLACEHOLDER_KEYS = {"", "your_gemini_api_key_here", "changeme"}


class ConfigError(ValueError):
    """Raised when required configuration is missing or invalid."""


@dataclass(frozen=True)
class Settings:
    gemini_api_key: str
    gemini_model: str
    gemini_voice: str
    gemini_api_version: str
    system_instruction: str
    allowed_origins: tuple[str, ...]
    token_rate_limit_per_minute: int
    token_ttl_minutes: int
    auth_token: str

    def __repr__(self) -> str:  # never leak the key into logs
        return (
            f"Settings(model={self.gemini_model!r}, voice={self.gemini_voice!r}, "
            f"api_version={self.gemini_api_version!r}, origins={self.allowed_origins!r})"
        )


def _int(env: Mapping[str, str], name: str, default: int, minimum: int, maximum: int) -> int:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}.") from exc
    if not minimum <= value <= maximum:
        raise ConfigError(f"{name} must be between {minimum} and {maximum}, got {value}.")
    return value


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Build Settings from the environment, raising ConfigError with an actionable message."""
    env = os.environ if env is None else env

    api_key = env.get("GEMINI_API_KEY", "").strip()
    if api_key.lower() in PLACEHOLDER_KEYS:
        raise ConfigError(
            "GEMINI_API_KEY is not set. Create an API key at "
            "https://aistudio.google.com/apikey, then copy backend/.env.example to "
            "backend/.env and set GEMINI_API_KEY there."
        )

    model = env.get("GEMINI_MODEL", "").strip() or DEFAULT_MODEL
    if model.startswith("models/"):
        model = model.removeprefix("models/")
    if not model.startswith("gemini-"):
        raise ConfigError(f"GEMINI_MODEL must be a Gemini Live model id, got {model!r}.")

    api_version = env.get("GEMINI_API_VERSION", "").strip() or DEFAULT_API_VERSION
    if api_version not in {"v1alpha", "v1beta"}:
        raise ConfigError(f"GEMINI_API_VERSION must be v1alpha or v1beta, got {api_version!r}.")

    origins = tuple(
        o.strip().rstrip("/")
        for o in env.get("ALLOWED_ORIGINS", "http://localhost:3000").split(",")
        if o.strip()
    )
    if "*" in origins:
        raise ConfigError("ALLOWED_ORIGINS must list explicit origins; '*' is not allowed.")

    return Settings(
        gemini_api_key=api_key,
        gemini_model=model,
        gemini_voice=env.get("GEMINI_VOICE", "").strip() or DEFAULT_VOICE,
        gemini_api_version=api_version,
        system_instruction=env.get("GEMINI_SYSTEM_INSTRUCTION", "").strip()
        or DEFAULT_SYSTEM_INSTRUCTION,
        allowed_origins=origins,
        token_rate_limit_per_minute=_int(env, "TOKEN_RATE_LIMIT_PER_MINUTE", 10, 1, 1000),
        token_ttl_minutes=_int(env, "TOKEN_TTL_MINUTES", 30, 2, 60),
        auth_token=env.get("AUTH_TOKEN", "").strip(),
    )
