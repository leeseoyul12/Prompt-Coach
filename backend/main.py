from typing import List

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError

from .config import settings
from .providers import (
    GeminiPromptProvider,
    PromptAnalysisProvider,
    ProviderConfigError,
    ProviderRequestError,
)


class ImproveRequest(BaseModel):
    prompt: str = Field(..., min_length=1, description="Original user prompt")


class Issue(BaseModel):
    type: str
    description: str


class ImproveResponse(BaseModel):
    issues: List[Issue]
    improved_prompt: str


def get_provider() -> PromptAnalysisProvider:
    """
    Return provider implementation by name.
    Keeping this small factory makes OpenAI provider swap easy later.
    """
    if settings.provider == "gemini":
        return GeminiPromptProvider(
            api_key=settings.gemini_api_key,
            model=settings.gemini_model,
            api_base=settings.gemini_api_base,
        )

    raise ProviderConfigError(
        f"Unsupported PROMPT_COACH_PROVIDER: '{settings.provider}'"
    )


app = FastAPI(title="Prompt Coach API")

# Allow local Chrome extension -> local FastAPI communication.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/improve", response_model=ImproveResponse)
def improve_prompt(request: ImproveRequest) -> ImproveResponse:
    """Analyze prompt text via configured provider and return MVP response schema."""
    try:
        provider = get_provider()
        result = provider.analyze_prompt(request.prompt)
        return ImproveResponse(**result)
    except ProviderConfigError as exc:
        # .env key missing or provider name invalid.
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except ProviderRequestError as exc:
        # Upstream AI API/network errors are returned as 502.
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except ValidationError as exc:
        # Provider returned JSON that does not match API contract.
        raise HTTPException(
            status_code=502,
            detail="Provider response schema is invalid. Try again.",
        ) from exc
