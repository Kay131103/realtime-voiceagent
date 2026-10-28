"""Ephemeral Gemini Live API tokens.

The browser never sees GEMINI_API_KEY. Instead the backend mints a short-lived,
single-use token that is locked to our model, voice, system instruction and
transcription settings, and the browser opens the Live WebSocket with it.
See https://ai.google.dev/gemini-api/docs/ephemeral-tokens
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Protocol

from google import genai
from google.genai import types

from .config import Settings

# How long the browser has to open the first WebSocket with a fresh token.
NEW_SESSION_WINDOW = dt.timedelta(minutes=1)


@dataclass(frozen=True)
class IssuedToken:
    token: str
    model: str
    api_version: str
    expire_time: dt.datetime
    new_session_expire_time: dt.datetime


class TokenIssuer(Protocol):
    async def issue(self) -> IssuedToken: ...


class TokenIssueError(RuntimeError):
    """Gemini refused to issue a token (bad key, quota, network...)."""


def build_live_config(settings: Settings) -> types.LiveConnectConfig:
    """Session config that is locked into every token we issue."""
    return types.LiveConnectConfig(
        response_modalities=[types.Modality.AUDIO],
        system_instruction=settings.system_instruction,
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=settings.gemini_voice)
            )
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        # Lets conversations outlive the default context window.
        context_window_compression=types.ContextWindowCompressionConfig(
            sliding_window=types.SlidingWindow()
        ),
    )


def build_token_config(settings: Settings, now: dt.datetime) -> types.CreateAuthTokenConfig:
    return types.CreateAuthTokenConfig(
        uses=1,  # resuming a session does not count as a use
        expire_time=now + dt.timedelta(minutes=settings.token_ttl_minutes),
        new_session_expire_time=now + NEW_SESSION_WINDOW,
        live_connect_constraints=types.LiveConnectConstraints(
            model=settings.gemini_model,
            config=build_live_config(settings),
        ),
        # Empty list = lock exactly the fields set above; the client may still
        # pass fields we left unset, such as a session resumption handle.
        lock_additional_fields=[],
    )


class GeminiTokenIssuer:
    def __init__(self, settings: Settings, client: genai.Client | None = None) -> None:
        self._settings = settings
        self._client = client or genai.Client(
            api_key=settings.gemini_api_key,
            http_options=types.HttpOptions(api_version=settings.gemini_api_version),
        )

    async def issue(self) -> IssuedToken:
        now = dt.datetime.now(dt.UTC)
        config = build_token_config(self._settings, now)
        try:
            token = await self._client.aio.auth_tokens.create(config=config)
        except Exception as exc:  # SDK raises several error types; normalise them
            detail = _describe(exc).replace(self._settings.gemini_api_key, "***")
            raise TokenIssueError(detail) from exc
        if not token.name:
            raise TokenIssueError("Gemini returned an empty token.")
        assert config.expire_time is not None and config.new_session_expire_time is not None
        return IssuedToken(
            token=token.name,
            model=self._settings.gemini_model,
            api_version=self._settings.gemini_api_version,
            expire_time=config.expire_time,
            new_session_expire_time=config.new_session_expire_time,
        )


def _describe(exc: Exception) -> str:
    code = getattr(exc, "code", None)
    message = getattr(exc, "message", None) or str(exc) or type(exc).__name__
    if code in (400, 401, 403):
        return f"Gemini rejected the API key or request ({code}): {message}"
    if code == 429:
        return "Gemini quota exceeded (429). Try again later."
    return f"Could not create a Gemini session token: {message}"
