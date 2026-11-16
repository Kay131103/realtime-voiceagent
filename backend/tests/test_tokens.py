import asyncio
import datetime as dt
from types import SimpleNamespace

import pytest
from google.genai import types

from app.config import Settings, load_settings
from app.rate_limit import RateLimiter
from app.tokens import GeminiTokenIssuer, TokenIssueError, build_token_config

from .conftest import FAKE_KEY


def test_token_config_is_single_use_and_locked(settings: Settings) -> None:
    now = dt.datetime(2026, 1, 1, tzinfo=dt.UTC)
    cfg = build_token_config(settings, now)
    assert cfg.uses == 1
    assert cfg.expire_time == now + dt.timedelta(minutes=30)
    assert cfg.new_session_expire_time == now + dt.timedelta(minutes=1)
    assert cfg.lock_additional_fields == []
    constraints = cfg.live_connect_constraints
    assert constraints is not None and constraints.model == settings.gemini_model
    live = constraints.config
    assert live is not None
    assert live.response_modalities == [types.Modality.AUDIO]
    assert live.input_audio_transcription is not None
    assert live.output_audio_transcription is not None
    assert settings.system_instruction in str(live.system_instruction)
    assert live.session_resumption is None  # left unlocked so the client can resume


def _live_config(cfg: types.CreateAuthTokenConfig) -> types.LiveConnectConfig:
    constraints = cfg.live_connect_constraints
    live = constraints.config if constraints else None
    assert live is not None
    return live


def _speech(live: types.LiveConnectConfig) -> types.SpeechConfig:
    speech = live.speech_config
    assert speech is not None
    return speech


def test_auto_language_config(settings: Settings) -> None:
    now = dt.datetime(2026, 1, 1, tzinfo=dt.UTC)
    live = _live_config(build_token_config(settings, now, "auto"))
    # No language pin: the voice follows the user's language.
    assert _speech(live).language_code is None
    instruction = str(live.system_instruction)
    assert "same language the user is currently speaking" in instruction
    assert settings.system_instruction in instruction


def test_pinned_language_config(settings: Settings) -> None:
    now = dt.datetime(2026, 1, 1, tzinfo=dt.UTC)
    live = _live_config(build_token_config(settings, now, "ta-IN"))
    assert _speech(live).language_code == "ta-IN"
    assert "Always respond in Tamil (ta-IN)" in str(live.system_instruction)


def test_language_defaults_to_settings(settings: Settings) -> None:
    settings = load_settings({**{"GEMINI_API_KEY": FAKE_KEY}, "GEMINI_LANGUAGE": "hi-IN"})
    now = dt.datetime(2026, 1, 1, tzinfo=dt.UTC)
    live = _live_config(build_token_config(settings, now))
    assert _speech(live).language_code == "hi-IN"


def test_invalid_language_raises(settings: Settings) -> None:
    now = dt.datetime(2026, 1, 1, tzinfo=dt.UTC)
    with pytest.raises(TokenIssueError, match="Invalid language"):
        build_token_config(settings, now, "not a language")


class _FakeTokens:
    def __init__(self, result: object = None, exc: Exception | None = None) -> None:
        self.result = result
        self.exc = exc
        self.config: types.CreateAuthTokenConfig | None = None

    async def create(self, *, config: types.CreateAuthTokenConfig) -> object:
        self.config = config
        if self.exc:
            raise self.exc
        return self.result


def _issuer_with(settings: Settings, fake: _FakeTokens) -> GeminiTokenIssuer:
    client = SimpleNamespace(aio=SimpleNamespace(auth_tokens=fake))
    return GeminiTokenIssuer(settings, client)  # type: ignore[arg-type]


def test_issuer_returns_token_name(settings: Settings) -> None:
    fake = _FakeTokens(result=types.AuthToken(name="auth_tokens/abc"))
    issued = asyncio.run(_issuer_with(settings, fake).issue())
    assert issued.token == "auth_tokens/abc"
    assert fake.config is not None and fake.config.uses == 1


def test_issuer_wraps_errors_and_scrubs_key(settings: Settings) -> None:
    fake = _FakeTokens(exc=RuntimeError(f"boom key={FAKE_KEY}"))
    with pytest.raises(TokenIssueError) as info:
        asyncio.run(_issuer_with(settings, fake).issue())
    assert FAKE_KEY not in str(info.value)


def test_issuer_rejects_empty_token(settings: Settings) -> None:
    fake = _FakeTokens(result=types.AuthToken(name=None))
    with pytest.raises(TokenIssueError, match="empty"):
        asyncio.run(_issuer_with(settings, fake).issue())


def test_rate_limiter_window() -> None:
    t = [0.0]
    limiter = RateLimiter(2, 60, clock=lambda: t[0])
    assert limiter.allow("a") and limiter.allow("a")
    assert not limiter.allow("a")
    assert limiter.allow("b")
    t[0] = 61
    assert limiter.allow("a")
