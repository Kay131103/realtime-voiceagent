"""ASGI entry point (`uvicorn app.asgi:app`). Loads backend/.env if present."""

from dotenv import load_dotenv

from .main import create_app

load_dotenv()
app = create_app()
