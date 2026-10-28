"""FastAPI app: health check and ephemeral-token endpoint for the browser client."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .config import Settings, load_settings
from .rate_limit import RateLimiter
from .tokens import GeminiTokenIssuer, TokenIssueError, TokenIssuer

logger = logging.getLogger("voice_agent")


class SessionTokenResponse(BaseModel):
    token: str
    model: str
    apiVersion: str  # noqa: N815 - camelCase for the JS client
    expireTime: str  # noqa: N815
    newSessionExpireTime: str  # noqa: N815


def create_app(
    settings: Settings | None = None,
    issuer_factory: Callable[[Settings], TokenIssuer] = GeminiTokenIssuer,
) -> FastAPI:
    # Validate eagerly so a missing key fails at startup, not on first request.
    settings = settings or load_settings()
    issuer = issuer_factory(settings)
    limiter = RateLimiter(settings.token_rate_limit_per_minute)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        logger.info("Voice agent backend ready: %r", settings)
        yield

    app = FastAPI(title="Gemini Live Voice Agent backend", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return {"status": "ok", "model": settings.gemini_model}

    @app.post("/api/session-token", response_model=SessionTokenResponse)
    async def session_token(request: Request) -> SessionTokenResponse:
        client_ip = request.client.host if request.client else "unknown"
        if not limiter.allow(client_ip):
            raise HTTPException(429, "Too many session requests. Wait a minute and try again.")
        try:
            issued = await issuer.issue()
        except TokenIssueError as exc:
            logger.warning("Token issue failed: %s", exc)
            raise HTTPException(502, str(exc)) from exc
        return SessionTokenResponse(
            token=issued.token,
            model=issued.model,
            apiVersion=issued.api_version,
            expireTime=issued.expire_time.isoformat(),
            newSessionExpireTime=issued.new_session_expire_time.isoformat(),
        )

    return app
