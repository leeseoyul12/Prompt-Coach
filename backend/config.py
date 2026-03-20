import os
from dataclasses import dataclass

from dotenv import load_dotenv

# Load environment variables from a local .env file if it exists.
load_dotenv()


@dataclass(frozen=True)
class Settings:
    provider: str = os.getenv("PROMPT_COACH_PROVIDER", "gemini").strip().lower()
    gemini_api_key: str = os.getenv("GEMINI_API_KEY", "").strip()
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-2.0-flash").strip()
    gemini_api_base: str = os.getenv(
        "GEMINI_API_BASE", "https://generativelanguage.googleapis.com/v1beta"
    ).strip()


settings = Settings()
