import pytest

from app.config import DEFAULT_MODEL, ConfigError, load_settings


@pytest.mark.parametrize("key", [None, "", "   ", "your_gemini_api_key_here"])
def test_missing_or_placeholder_key_is_rejected(key: str | None) -> None:
    env = {} if key is None else {"GEMINI_API_KEY": key}
    with pytest.raises(ConfigError, match="GEMINI_API_KEY is not set"):
        load_settings(env)


def test_defaults() -> None:
    s = load_settings({"GEMINI_API_KEY": "k"})
    assert s.gemini_model == DEFAULT_MODEL
    assert s.gemini_api_version == "v1alpha"
    assert s.allowed_origins == ("http://localhost:3000",)
    assert s.token_rate_limit_per_minute == 10


def test_models_prefix_is_stripped() -> None:
    s = load_settings({"GEMINI_API_KEY": "k", "GEMINI_MODEL": "models/gemini-x"})
    assert s.gemini_model == "gemini-x"


@pytest.mark.parametrize(
    ("name", "value", "message"),
    [
        ("GEMINI_MODEL", "gpt-4o", "GEMINI_MODEL"),
        ("GEMINI_API_VERSION", "v2", "GEMINI_API_VERSION"),
        ("ALLOWED_ORIGINS", "*", "ALLOWED_ORIGINS"),
        ("TOKEN_RATE_LIMIT_PER_MINUTE", "abc", "integer"),
        ("TOKEN_TTL_MINUTES", "500", "between"),
    ],
)
def test_invalid_values(name: str, value: str, message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        load_settings({"GEMINI_API_KEY": "k", name: value})


def test_repr_does_not_leak_key() -> None:
    s = load_settings({"GEMINI_API_KEY": "super-secret-value"})
    assert "super-secret-value" not in repr(s)
    assert "super-secret-value" not in str(s)
