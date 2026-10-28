import pytest

from app import __main__ as cli


def test_cli_exits_with_clear_error_when_key_missing(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cli, "load_dotenv", lambda: None)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert cli.main() == 1
    assert "GEMINI_API_KEY is not set" in capsys.readouterr().err
