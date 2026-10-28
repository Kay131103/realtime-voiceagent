import asyncio
import datetime as dt
from types import SimpleNamespace

import pytest
from google.genai import types

from app.config import Settings
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
    assert live.system_instruction == settings.system_instruction
    assert live.session_resumption is None  # left unlocked so the client can resume


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
