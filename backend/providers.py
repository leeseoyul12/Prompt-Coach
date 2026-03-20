import json
from dataclasses import dataclass
from typing import Any, Dict, List, Protocol

import httpx


class ProviderConfigError(RuntimeError):
    """Raised when required provider config is missing."""


class ProviderRequestError(RuntimeError):
    """Raised when the AI provider request or response is invalid."""


class PromptAnalysisProvider(Protocol):
    def analyze_prompt(self, prompt: str) -> Dict[str, Any]:
        """Return a dict matching ImproveResponse schema."""


def _strip_code_fence(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()
    return cleaned


def _extract_text_from_gemini(payload: Dict[str, Any]) -> str:
    candidates: List[Dict[str, Any]] = payload.get("candidates", [])
    if not candidates:
        return ""

    first_candidate = candidates[0]
    content = first_candidate.get("content", {})
    parts = content.get("parts", [])
    if not parts:
        return ""

    text_parts = [part.get("text", "") for part in parts if isinstance(part, dict)]
    return "\n".join(part for part in text_parts if part).strip()


def _build_gemini_instruction(prompt: str) -> str:
    return f"""
You are a prompt-improvement assistant.
Analyze the user's prompt and return JSON only.

Rules:
1. Return exactly this JSON shape:
{{
  "issues": [
    {{"type": "string", "description": "string"}}
  ],
  "improved_prompt": "string"
}}
2. issues must contain 2 or 3 items.
3. Keep issue descriptions to one short sentence each.
4. improved_prompt must be practical, clearer, and more specific.
5. Use Korean in both issues and improved_prompt.
6. Do not include markdown, explanations, or extra keys.

User prompt:
{prompt}
""".strip()


@dataclass
class GeminiPromptProvider:
    api_key: str
    model: str
    api_base: str
    timeout_seconds: float = 20.0

    def analyze_prompt(self, prompt: str) -> Dict[str, Any]:
        if not self.api_key:
            raise ProviderConfigError(
                "GEMINI_API_KEY is missing. Add it to your .env file."
            )

        endpoint = f"{self.api_base}/models/{self.model}:generateContent"
        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": _build_gemini_instruction(prompt)}],
                }
            ],
            "generationConfig": {"temperature": 0.2},
        }

        try:
            response = httpx.post(
                endpoint,
                params={"key": self.api_key},
                json=payload,
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            error_body = exc.response.text[:300]
            raise ProviderRequestError(
                f"Gemini API returned HTTP {exc.response.status_code}: {error_body}"
            ) from exc
        except httpx.RequestError as exc:
            raise ProviderRequestError(
                "Failed to call Gemini API. Check network and API endpoint settings."
            ) from exc

        raw_text = _extract_text_from_gemini(response.json())
        if not raw_text:
            raise ProviderRequestError("Gemini API response did not contain text.")

        cleaned_text = _strip_code_fence(raw_text)
        try:
            parsed = json.loads(cleaned_text)
        except json.JSONDecodeError as exc:
            raise ProviderRequestError(
                "Gemini response was not valid JSON in expected schema."
            ) from exc

        if not isinstance(parsed, dict):
            raise ProviderRequestError("Gemini response JSON root must be an object.")

        return parsed
