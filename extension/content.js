const PROMPT_COACH_BUTTON_ID = "prompt-coach-trigger";
const PROMPT_COACH_WRAPPER_CLASS = "prompt-coach-wrapper";
const PROMPT_COACH_POPUP_ID = "prompt-coach-popup";
const PROMPT_COACH_API_URL = "http://127.0.0.1:8000/improve";

/**
 * ChatGPT input box selector.
 * The current UI uses #prompt-textarea, so we check that first.
 */
function getPromptInputElement() {
  return document.querySelector("#prompt-textarea");
}

/**
 * Returns the text currently written in the ChatGPT input.
 */
function getPromptText(inputElement) {
  if (!inputElement) {
    return "";
  }

  if (inputElement instanceof HTMLTextAreaElement) {
    return inputElement.value.trim();
  }

  return inputElement.innerText?.trim() ?? inputElement.textContent?.trim() ?? "";
}

/**
 * Replaces all text inside a contenteditable element.
 */
function setContentEditableText(element, nextValue) {
  element.focus();
  element.replaceChildren(document.createTextNode(nextValue));

  const inputEvent = new InputEvent("input", {
    bubbles: true,
    cancelable: true,
    data: nextValue,
    inputType: "insertText"
  });

  element.dispatchEvent(inputEvent);
}

/**
 * Updates the input in a way that also notifies React-style listeners.
 */
function setPromptText(inputElement, nextValue) {
  if (inputElement instanceof HTMLTextAreaElement) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(inputElement, nextValue);
    } else {
      inputElement.value = nextValue;
    }

    inputElement.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  setContentEditableText(inputElement, nextValue);
}

/**
 * Removes the popup if it already exists.
 */
function removePromptCoachPopup() {
  const existingPopup = document.querySelector(`#${PROMPT_COACH_POPUP_ID}`);

  if (existingPopup) {
    existingPopup.remove();
  }
}

/**
 * Calls FastAPI backend and returns prompt analysis JSON.
 */
async function requestPromptImprovement(promptText) {
  const response = await fetch(PROMPT_COACH_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt: promptText
    })
  });

  if (!response.ok) {
    let detail = `Request failed with status ${response.status}`;

    try {
      const errorData = await response.json();
      if (typeof errorData?.detail === "string" && errorData.detail.trim()) {
        detail = errorData.detail;
      }
    } catch (jsonError) {
      // Keep default message when error body is not valid JSON.
      console.debug("[Prompt Coach] Error response parsing failed:", jsonError);
    }

    throw new Error(detail);
  }

  return response.json();
}

/**
 * Creates popup shell first. Result content is filled later.
 */
function createPromptCoachPopup(currentPrompt) {
  removePromptCoachPopup();

  const popup = document.createElement("div");
  popup.id = PROMPT_COACH_POPUP_ID;
  popup.className = "prompt-coach-popup";

  popup.innerHTML = `
    <div class="prompt-coach-popup-header">
      <h3>Prompt Coach</h3>
      <button type="button" class="prompt-coach-close-button" aria-label="Close">×</button>
    </div>
    <div class="prompt-coach-popup-section">
      <p class="prompt-coach-section-title">Current Prompt</p>
      <div class="prompt-coach-preview"></div>
    </div>
    <div class="prompt-coach-results"></div>
    <div class="prompt-coach-popup-actions">
      <button type="button" class="prompt-coach-secondary-button" data-action="keep">
        Keep
      </button>
      <button type="button" class="prompt-coach-primary-button" data-action="apply" disabled>
        Apply
      </button>
    </div>
  `;

  const previewElement = popup.querySelector(".prompt-coach-preview");
  const resultsContainer = popup.querySelector(".prompt-coach-results");
  const closeButton = popup.querySelector(".prompt-coach-close-button");
  const keepButton = popup.querySelector('[data-action="keep"]');
  const applyButton = popup.querySelector('[data-action="apply"]');

  if (previewElement) {
    previewElement.textContent = currentPrompt || "No prompt text found.";
  }

  closeButton?.addEventListener("click", () => {
    removePromptCoachPopup();
  });

  keepButton?.addEventListener("click", () => {
    removePromptCoachPopup();
  });

  document.body.appendChild(popup);

  return {
    popup,
    resultsContainer,
    applyButton
  };
}

/**
 * Shows loading text while API request is running.
 */
function renderLoadingState(resultsContainer) {
  if (!resultsContainer) {
    return;
  }

  resultsContainer.innerHTML = `
    <div class="prompt-coach-popup-section">
      <p class="prompt-coach-section-title">Analysis</p>
      <div class="prompt-coach-status">Analyzing prompt...</div>
    </div>
  `;
}

/**
 * Shows error text in popup when request fails.
 */
function renderErrorState(resultsContainer, message) {
  if (!resultsContainer) {
    return;
  }

  resultsContainer.innerHTML = `
    <div class="prompt-coach-popup-section">
      <p class="prompt-coach-section-title">Error</p>
      <div class="prompt-coach-error-box">${message}</div>
    </div>
  `;
}

/**
 * Renders issue items in the popup.
 */
function renderIssues(issueListElement, issues) {
  issues.forEach((issue) => {
    const issueItem = document.createElement("li");
    issueItem.className = "prompt-coach-issue-item";

    const issueTitle = document.createElement("strong");
    issueTitle.textContent = issue.type;

    const issueDescription = document.createElement("p");
    issueDescription.textContent = issue.description;

    issueItem.appendChild(issueTitle);
    issueItem.appendChild(issueDescription);
    issueListElement.appendChild(issueItem);
  });
}

/**
 * Shows API analysis content inside the popup.
 */
function renderAnalysisState(resultsContainer, analysisResult) {
  if (!resultsContainer) {
    return;
  }

  resultsContainer.innerHTML = `
    <div class="prompt-coach-popup-section">
      <p class="prompt-coach-section-title">Issues</p>
      <ul class="prompt-coach-issue-list"></ul>
    </div>
    <div class="prompt-coach-popup-section">
      <p class="prompt-coach-section-title">Improved Prompt</p>
      <div class="prompt-coach-improved-prompt"></div>
    </div>
  `;

  const issueListElement = resultsContainer.querySelector(".prompt-coach-issue-list");
  const improvedPromptElement = resultsContainer.querySelector(
    ".prompt-coach-improved-prompt"
  );

  if (issueListElement) {
    renderIssues(issueListElement, analysisResult?.issues || []);
  }

  if (improvedPromptElement) {
    improvedPromptElement.textContent = analysisResult?.improved_prompt || "";
  }
}

/**
 * Handles click: read prompt, request backend analysis, then render result.
 */
async function handlePromptCoachClick(inputElement) {
  const promptText = getPromptText(inputElement);
  console.log("[Prompt Coach] Current prompt:", promptText);

  const popupParts = createPromptCoachPopup(promptText);
  renderLoadingState(popupParts.resultsContainer);

  try {
    const analysisResult = await requestPromptImprovement(promptText);
    renderAnalysisState(popupParts.resultsContainer, analysisResult);

    if (popupParts.applyButton) {
      popupParts.applyButton.disabled = false;
      popupParts.applyButton.addEventListener(
        "click",
        () => {
          const improvedPrompt = analysisResult?.improved_prompt || "";
          setPromptText(inputElement, improvedPrompt);
          inputElement.focus();
          removePromptCoachPopup();
        },
        { once: true }
      );
    }
  } catch (error) {
    console.error("[Prompt Coach] Failed to improve prompt:", error);
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Could not connect to backend server.";
    renderErrorState(popupParts.resultsContainer, message);
  }
}

/**
 * Adds the Prompt Coach button next to the ChatGPT input box.
 * If the button already exists, we do nothing.
 */
function injectPromptCoachButton() {
  const inputElement = getPromptInputElement();

  if (!inputElement) {
    return;
  }

  const inputWrapper = inputElement.parentElement;

  if (!inputWrapper) {
    return;
  }

  // Prevent duplicate button creation when the page re-renders.
  if (inputWrapper.querySelector(`#${PROMPT_COACH_BUTTON_ID}`)) {
    return;
  }

  inputWrapper.classList.add(PROMPT_COACH_WRAPPER_CLASS);

  const button = document.createElement("button");
  button.id = PROMPT_COACH_BUTTON_ID;
  button.type = "button";
  button.className = "prompt-coach-button";
  button.textContent = "✨";
  button.title = "Prompt Coach";
  button.setAttribute("aria-label", "Prompt Coach");

  button.addEventListener("click", () => {
    const latestInput = getPromptInputElement();

    if (!latestInput) {
      return;
    }

    handlePromptCoachClick(latestInput);
  });

  inputWrapper.appendChild(button);
}

/**
 * ChatGPT updates the page dynamically, so we observe DOM changes
 * and try to inject the button whenever the input box appears again.
 */
function startPromptCoach() {
  injectPromptCoachButton();

  const observer = new MutationObserver(() => {
    injectPromptCoachButton();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

startPromptCoach();
