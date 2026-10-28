from __future__ import annotations

import datetime as dt

import pytest

from app.config import Settings, load_settings
from app.tokens import IssuedToken, TokenIssueError

FAKE_KEY = "test-key-not-real"


@pytest.fixture
def settings() -> Settings:
    return load_settings({"GEMINI_API_KEY": FAKE_KEY, "TOKEN_RATE_LIMIT_PER_MINUTE": "3"})


class FakeIssuer:
    """Stands in for Gemini; no network access in unit tests."""

    def __init__(self, settings: Settings, fail: str | None = None) -> None:
        self.settings = settings
        self.fail = fail
        self.calls = 0

    async def issue(self) -> IssuedToken:
        self.calls += 1
        if self.fail:
            raise TokenIssueError(self.fail)
        now = dt.datetime(2026, 1, 1, tzinfo=dt.UTC)
        return IssuedToken(
            token=f"auth_tokens/fake-{self.calls}",
            model=self.settings.gemini_model,
            api_version=self.settings.gemini_api_version,
            expire_time=now + dt.timedelta(minutes=30),
            new_session_expire_time=now + dt.timedelta(minutes=1),
        )
