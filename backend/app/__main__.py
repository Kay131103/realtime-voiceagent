"""`python -m app` - validate configuration, then serve with uvicorn."""

from __future__ import annotations

import logging
import os
import sys

import uvicorn
from dotenv import load_dotenv

from .config import ConfigError, load_settings
from .main import create_app


def main() -> int:
    load_dotenv()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    try:
        settings = load_settings()
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 1
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(create_app(settings), host=host, port=port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
