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

from .config import Settings, parse_language

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
    async def issue(self, language: str | None = None) -> IssuedToken: ...


class TokenIssueError(RuntimeError):
    """Gemini refused to issue a token (bad key, quota, network...)."""


# English names for the language directive; unknown codes are used verbatim.
LANGUAGE_NAMES = {
    "en-US": "English (US)",
    "en-GB": "English (UK)",
    "en-IN": "English (India)",
    "hi-IN": "Hindi",
    "ta-IN": "Tamil",
    "te-IN": "Telugu",
    "kn-IN": "Kannada",
    "ml-IN": "Malayalam",
    "bn-IN": "Bengali",
    "mr-IN": "Marathi",
    "gu-IN": "Gujarati",
    "pa-IN": "Punjabi",
    "ur-IN": "Urdu",
    "es-ES": "Spanish",
    "es-US": "Spanish",
    "fr-FR": "French",
    "de-DE": "German",
    "pt-BR": "Portuguese",
    "it-IT": "Italian",
    "ru-RU": "Russian",
    "ar-EG": "Arabic",
    "zh-CN": "Mandarin Chinese",
    "ja-JP": "Japanese",
    "ko-KR": "Korean",
    "id-ID": "Indonesian",
    "th-TH": "Thai",
    "vi-VN": "Vietnamese",
    "tr-TR": "Turkish",
}

AUTO_LANGUAGE = "auto"


def language_directive(language: str) -> str:
    """System-instruction text that keeps the model's spoken language on target."""
    if language == AUTO_LANGUAGE:
        return (
            "Always respond in the same language the user is currently speaking. "
            "If they switch languages mid-conversation, switch with them. If they "
            "mix languages in one utterance, mirror their dominant language."
        )
    name = LANGUAGE_NAMES.get(language, language)
    return (
        f"Always respond in {name} ({language}); never switch to another language, "
        "even if the user mixes languages or speaks in a different one."
    )


def build_live_config(settings: Settings, language: str) -> types.LiveConnectConfig:
    """Session config that is locked into every token we issue."""
    speech_config = types.SpeechConfig(
        voice_config=types.VoiceConfig(
            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=settings.gemini_voice)
        )
    )
    if language != AUTO_LANGUAGE:
        # language_code pins the language/accent of the prebuilt voice and is the
        # strongest guard against the native-audio voice drifting between languages.
        speech_config.language_code = language
    return types.LiveConnectConfig(
        response_modalities=[types.Modality.AUDIO],
        # The language directive goes first so it is not lost in a custom instruction.
        system_instruction=f"{language_directive(language)} {settings.system_instruction}",
        speech_config=speech_config,
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        # Server-side VAD tuning: START_SENSITIVITY_LOW only opens a turn on
        # clearly spoken audio, so speaker echo / background noise no longer
        # triggers barge-in and cuts the assistant off mid-sentence.
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_LOW,
                end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_HIGH,
                prefix_padding_ms=200,
                silence_duration_ms=500,
            ),
        ),
        # Lets conversations outlive the default context window.
        context_window_compression=types.ContextWindowCompressionConfig(
            sliding_window=types.SlidingWindow()
        ),
    )


def build_token_config(
    settings: Settings, now: dt.datetime, language: str | None = None
) -> types.CreateAuthTokenConfig:
    try:
        effective = parse_language(language, default=settings.gemini_language)
    except ValueError as exc:
        raise TokenIssueError(f"Invalid language requested: {exc}") from exc
    return types.CreateAuthTokenConfig(
        uses=1,  # resuming a session does not count as a use
        expire_time=now + dt.timedelta(minutes=settings.token_ttl_minutes),
        new_session_expire_time=now + NEW_SESSION_WINDOW,
        live_connect_constraints=types.LiveConnectConstraints(
            model=settings.gemini_model,
            config=build_live_config(settings, effective),
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

    async def issue(self, language: str | None = None) -> IssuedToken:
        now = dt.datetime.now(dt.UTC)
        config = build_token_config(self._settings, now, language)
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
