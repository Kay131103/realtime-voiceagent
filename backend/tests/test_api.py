from fastapi.testclient import TestClient

from app.config import Settings, load_settings
from app.main import create_app

from .conftest import FAKE_KEY, FakeIssuer


def make_client(settings: Settings, fail: str | None = None) -> TestClient:
    return TestClient(create_app(settings, lambda s: FakeIssuer(s, fail)))


def test_health(settings: Settings) -> None:
    res = make_client(settings).get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "model": settings.gemini_model}


def test_session_token_shape(settings: Settings) -> None:
    res = make_client(settings).post("/api/session-token")
    assert res.status_code == 200
    body = res.json()
    assert body["token"].startswith("auth_tokens/")
    assert body["model"] == settings.gemini_model
    assert body["apiVersion"] == "v1alpha"
    assert body["expireTime"] > body["newSessionExpireTime"]
    assert FAKE_KEY not in res.text


def test_session_token_rate_limited(settings: Settings) -> None:
    client = make_client(settings)
    codes = [client.post("/api/session-token").status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]


def test_gemini_failure_maps_to_502(settings: Settings) -> None:
    res = make_client(settings, fail="Gemini rejected the API key").post("/api/session-token")
    assert res.status_code == 502
    assert "rejected" in res.json()["detail"]


def test_get_not_allowed_on_token_endpoint(settings: Settings) -> None:
    assert make_client(settings).get("/api/session-token").status_code == 405


def test_cors_only_for_allowed_origins(settings: Settings) -> None:
    client = make_client(settings)
    preflight = {"Access-Control-Request-Method": "POST"}
    ok = client.options(
        "/api/session-token", headers={"Origin": "http://localhost:3000", **preflight}
    )
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:3000"
    bad = client.options(
        "/api/session-token", headers={"Origin": "https://evil.example", **preflight}
    )
    assert "access-control-allow-origin" not in bad.headers


def test_session_token_requires_auth_when_configured() -> None:
    settings = load_settings({"GEMINI_API_KEY": FAKE_KEY, "AUTH_TOKEN": "s3cret"})
    client = make_client(settings)
    assert client.post("/api/session-token").status_code == 401
    assert (
        client.post("/api/session-token", headers={"Authorization": "Bearer nope"}).status_code
        == 401
    )
    assert (
        client.post("/api/session-token", headers={"Authorization": "Bearer s3cret"}).status_code
        == 200
    )
