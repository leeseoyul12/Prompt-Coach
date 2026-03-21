from typing import List

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError

try:
    from .config import settings
    from .providers import (
        GeminiPromptProvider,
        PromptAnalysisProvider,
        ProviderConfigError,
        ProviderRequestError,
    )
except ImportError:
    # backend 폴더에서 `uvicorn main:app`으로 실행할 때를 위한 fallback import
    from config import settings
    from providers import (
        GeminiPromptProvider,
        PromptAnalysisProvider,
        ProviderConfigError,
        ProviderRequestError,
    )


class ImproveRequest(BaseModel):
    prompt: str = Field(..., min_length=1, description="Original user prompt")


class Issue(BaseModel):
    # 카테고리명은 비어 있지 않도록 최소 길이를 둔다.
    type: str = Field(..., min_length=1, max_length=60)
    # 한 줄 설명 규칙을 지키기 위해 줄바꿈 문자를 금지한다.
    description: str = Field(
        ...,
        min_length=1,
        max_length=200,
        pattern=r"^[^\r\n]+$",
    )


class ImproveResponse(BaseModel):
    # 핵심 계약: 문제점 카테고리는 반드시 2~3개만 허용한다.
    issues: List[Issue] = Field(..., min_length=2, max_length=3)
    improved_prompt: str = Field(..., min_length=1)


ISSUE_TYPE_MAP = {
    "ambiguity": "모호한 표현",
    "unclear intent": "의도 불명확",
    "lack of context": "맥락 부족",
    "missing context": "맥락 부족",
    "missing constraints": "조건 부족",
    "lack of constraints": "조건 부족",
    "insufficient specificity": "구체성 부족",
    "not specific enough": "구체성 부족",
    "overly broad request": "범위 과도",
    "too broad": "범위 과도",
    "output format missing": "출력 형식 미지정",
    "missing output format": "출력 형식 미지정",
    "format mismatch": "형식 불일치",
    "role not defined": "역할 미지정",
    "audience unclear": "대상 불명확",
    "objective unclear": "목표 불명확",
}


def _normalize_issue_key(raw: str) -> str:
    return " ".join(raw.strip().lower().replace("_", " ").replace("-", " ").split())


def _contains_korean(text: str) -> bool:
    return any("가" <= ch <= "힣" for ch in text)


def localize_issue_type(raw_type: str) -> str:
    normalized = _normalize_issue_key(raw_type)
    if not normalized:
        return "표현 개선 필요"

    if _contains_korean(raw_type):
        return raw_type.strip()

    if normalized in ISSUE_TYPE_MAP:
        return ISSUE_TYPE_MAP[normalized]

    return "표현 개선 필요"


def localize_provider_error(message: str) -> str:
    lowered = message.lower()

    if "http 429" in lowered:
        return "AI 사용량 한도를 초과했습니다. 잠시 후 다시 시도해 주세요."

    if "http 404" in lowered and "model" in lowered:
        return "선택한 Gemini 모델을 사용할 수 없습니다. .env의 GEMINI_MODEL 값을 확인해 주세요."

    return "AI 응답 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요."


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

# 로컬 Chrome 확장 프로그램 -> 로컬 FastAPI 통신 허용
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

        # issue type이 영어로 내려오면 한국어 카테고리로 정규화한다.
        issues = result.get("issues")
        if isinstance(issues, list):
            for issue in issues:
                if isinstance(issue, dict):
                    issue["type"] = localize_issue_type(str(issue.get("type", "")))

        return ImproveResponse(**result)
    except ProviderConfigError as exc:
        raw_message = str(exc)
        if "GEMINI_API_KEY is missing" in raw_message:
            detail = "GEMINI_API_KEY가 설정되지 않았습니다. backend/.env 파일을 확인해 주세요."
        else:
            detail = "AI Provider 설정에 문제가 있습니다. 설정값을 확인해 주세요."
        raise HTTPException(status_code=500, detail=detail) from exc
    except ProviderRequestError as exc:
        raise HTTPException(
            status_code=502, detail=localize_provider_error(str(exc))
        ) from exc
    except ValidationError as exc:
        raise HTTPException(
            status_code=502,
            detail="AI 응답 형식이 올바르지 않습니다. 잠시 후 다시 시도해 주세요.",
        ) from exc
