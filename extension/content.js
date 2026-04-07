const BETTER_PROMPT_BUTTON_ID = "better-prompt-trigger";
const BETTER_PROMPT_WRAPPER_CLASS = "better-prompt-wrapper";
const BETTER_PROMPT_POPUP_ID = "better-prompt-popup";
const BETTER_PROMPT_AUTH_STORAGE_KEY = "betterPromptAuth";

const BETTER_PROMPT_EMPTY_PROMPT_MESSAGE = "입력된 프롬프트가 없습니다.";
const BETTER_PROMPT_STALE_PROMPT_MESSAGE = "프롬프트가 바뀌었습니다. 다시 분석해 주세요.";
const BETTER_PROMPT_MIN_GUIDE_LENGTH = 15;
const BETTER_PROMPT_REQUEST_TIMEOUT_MS = 15000;

const BETTER_PROMPT_RUNTIME_CONFIG =
  typeof BETTER_PROMPT_CONFIG !== "undefined"
    ? BETTER_PROMPT_CONFIG
    : Object.freeze({
        apiBaseUrl: "https://YOUR-PUBLIC-BACKEND.example.com",
        apiUrl: "https://YOUR-PUBLIC-BACKEND.example.com/improve",
        googleClientId: "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",
        promptSelectors: ["#prompt-textarea"]
      });

let activeAnalysisRequestId = 0;
let isRequestInFlight = false;
let activeAnalysisSession = null;
let authState = {
  sessionToken: "",
  user: null
};

function getPromptSelectors() {
  return Array.isArray(BETTER_PROMPT_RUNTIME_CONFIG.promptSelectors) &&
    BETTER_PROMPT_RUNTIME_CONFIG.promptSelectors.length > 0
    ? BETTER_PROMPT_RUNTIME_CONFIG.promptSelectors
    : ["#prompt-textarea"];
}

function getApiBaseUrl() {
  if (typeof BETTER_PROMPT_RUNTIME_CONFIG.apiBaseUrl === "string" &&
      BETTER_PROMPT_RUNTIME_CONFIG.apiBaseUrl.trim()) {
    return BETTER_PROMPT_RUNTIME_CONFIG.apiBaseUrl.replace(/\/$/, "");
  }

  try {
    return new URL(BETTER_PROMPT_RUNTIME_CONFIG.apiUrl).origin;
  } catch (error) {
    console.warn("[Better Prompt] Failed to derive apiBaseUrl:", error);
    return "";
  }
}

function getImproveApiUrl() {
  if (typeof BETTER_PROMPT_RUNTIME_CONFIG.apiUrl === "string" &&
      BETTER_PROMPT_RUNTIME_CONFIG.apiUrl.trim()) {
    return BETTER_PROMPT_RUNTIME_CONFIG.apiUrl;
  }

  return getApiBaseUrl() + "/improve";
}

function buildApiUrl(path) {
  return getApiBaseUrl() + path;
}

function getGoogleClientId() {
  if (typeof BETTER_PROMPT_RUNTIME_CONFIG.googleClientId === "string") {
    return BETTER_PROMPT_RUNTIME_CONFIG.googleClientId.trim();
  }

  return "";
}

function isVisibleElement(element) {
  return element instanceof Element && element.getClientRects().length > 0;
}

function getPromptInputElement() {
  for (const selector of getPromptSelectors()) {
    const candidate = document.querySelector(selector);
    if (candidate && isVisibleElement(candidate)) {
      return candidate;
    }
  }

  const textareaCandidates = Array.from(document.querySelectorAll("textarea")).filter(
    isVisibleElement
  );

  const preferredTextarea = textareaCandidates.find(function(element) {
    return element.closest("form") || element.id.indexOf("prompt") !== -1;
  });

  if (preferredTextarea) {
    return preferredTextarea;
  }

  const editorCandidates = Array.from(
    document.querySelectorAll('[contenteditable="true"][role="textbox"]')
  ).filter(isVisibleElement);

  return editorCandidates.find(function(element) {
    return element.closest("form") || element.closest('[aria-label*="message" i]');
  }) || editorCandidates[0] || null;
}

function getPromptInputContainer(inputElement) {
  return inputElement.closest("form") || inputElement.parentElement || inputElement;
}

function getBottomRightActionButtons(inputWrapper) {
  if (!(inputWrapper instanceof Element)) {
    return [];
  }

  const wrapperRect = inputWrapper.getBoundingClientRect();
  return Array.from(inputWrapper.querySelectorAll("button")).filter(function(button) {
    if (!(button instanceof HTMLButtonElement)) {
      return false;
    }

    if (button.id === BETTER_PROMPT_BUTTON_ID || !isVisibleElement(button)) {
      return false;
    }

    const rect = button.getBoundingClientRect();
    const isNearBottom = rect.bottom >= wrapperRect.bottom - 80;
    const isNearRight = rect.left >= wrapperRect.left + wrapperRect.width / 2;
    return isNearBottom && isNearRight;
  });
}

function updateButtonLayout(inputWrapper) {
  if (!(inputWrapper instanceof HTMLElement)) {
    return;
  }

  const minimumRightOffset = 12;
  const minimumInputPadding = 96;
  const wrapperRect = inputWrapper.getBoundingClientRect();
  const actionButtons = getBottomRightActionButtons(inputWrapper);

  let buttonRightOffset = minimumRightOffset;
  if (actionButtons.length > 0) {
    const leftmostAction = Math.min.apply(
      Math,
      actionButtons.map(function(button) {
        return button.getBoundingClientRect().left;
      })
    );

    buttonRightOffset = Math.max(
      minimumRightOffset,
      Math.ceil(wrapperRect.right - leftmostAction + 8)
    );
  }

  const inputPadding = Math.max(minimumInputPadding, buttonRightOffset + 44);
  inputWrapper.style.setProperty("--better-prompt-button-right", buttonRightOffset + "px");
  inputWrapper.style.setProperty("--better-prompt-input-padding-right", inputPadding + "px");
}

function getPromptText(inputElement) {
  if (!inputElement) {
    return "";
  }

  if (inputElement instanceof HTMLTextAreaElement) {
    return inputElement.value.trim();
  }

  return ((inputElement.innerText || "").trim() ||
    (inputElement.textContent || "").trim());
}

function normalizePromptText(text) {
  return String(text || "").trim().replace(/\s+/g, " ");
}

function isShortPrompt(text) {
  return normalizePromptText(text).length > 0 &&
    normalizePromptText(text).length <= BETTER_PROMPT_MIN_GUIDE_LENGTH;
}

function shouldGuideForShortPrompt(text) {
  const normalized = normalizePromptText(text);
  return normalized.length > 0 && normalized.length <= BETTER_PROMPT_MIN_GUIDE_LENGTH;
}

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

function setPromptText(inputElement, nextValue) {
  if (inputElement instanceof HTMLTextAreaElement) {
    const descriptor = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    );
    const nativeSetter = descriptor && descriptor.set;

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

function readExtensionStorage(keys) {
  return new Promise(function(resolve) {
    if (!chrome.storage || !chrome.storage.local) {
      resolve({});
      return;
    }

    chrome.storage.local.get(keys, function(items) {
      resolve(items || {});
    });
  });
}

function writeExtensionStorage(items) {
  return new Promise(function(resolve) {
    if (!chrome.storage || !chrome.storage.local) {
      resolve();
      return;
    }

    chrome.storage.local.set(items, function() {
      resolve();
    });
  });
}

function removeExtensionStorage(keys) {
  return new Promise(function(resolve) {
    if (!chrome.storage || !chrome.storage.local) {
      resolve();
      return;
    }

    chrome.storage.local.remove(keys, function() {
      resolve();
    });
  });
}

function sendRuntimeMessage(message) {
  return new Promise(function(resolve, reject) {
    if (!chrome.runtime || !chrome.runtime.sendMessage) {
      reject(new Error("확장 프로그램 런타임에 접근할 수 없습니다."));
      return;
    }

    chrome.runtime.sendMessage(message, function(response) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response || {});
    });
  });
}

function normalizeFetchError(response, fallbackMessage) {
  return response.text().then(function(text) {
    try {
      const errorData = JSON.parse(text);
      if (errorData && typeof errorData.detail === "string" && errorData.detail.trim()) {
        return errorData.detail;
      }
    } catch (error) {
      console.debug("[Better Prompt] Failed to parse error response:", error);
    }

    return fallbackMessage || ("Request failed with status " + response.status);
  });
}

function requestPromptImprovement(promptText) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutId = controller
    ? window.setTimeout(function() {
        controller.abort();
      }, BETTER_PROMPT_REQUEST_TIMEOUT_MS)
    : 0;

  return fetch(getImproveApiUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    signal: controller ? controller.signal : undefined,
    body: JSON.stringify({
      prompt: promptText
    })
  }).then(function(response) {
    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }

    if (!response.ok) {
      return normalizeFetchError(response).then(function(detail) {
        throw new Error(detail);
      });
    }

    return response.json();
  }).catch(function(error) {
    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }

    if (error && error.name === "AbortError") {
      throw new Error("AI 응답이 너무 오래 걸립니다. 잠시 후 다시 시도해 주세요.");
    }

    throw error;
  });
}

function requestAuthorizedJson(path, options) {
  if (!authState.sessionToken) {
    return Promise.reject(new Error("로그인이 필요합니다."));
  }

  const nextOptions = Object.assign({}, options || {});
  nextOptions.headers = Object.assign({}, nextOptions.headers || {}, {
    Authorization: "Bearer " + authState.sessionToken
  });

  return fetch(buildApiUrl(path), nextOptions).then(function(response) {
    if (response.status === 401) {
      return clearAuthState().then(function() {
        throw new Error("로그인 세션이 만료됐습니다. 다시 로그인해 주세요.");
      });
    }

    if (!response.ok) {
      return normalizeFetchError(response).then(function(detail) {
        throw new Error(detail);
      });
    }

    if (response.status === 204) {
      return {};
    }

    return response.text().then(function(text) {
      return text ? JSON.parse(text) : {};
    });
  });
}

function loadStoredAuthState() {
  return readExtensionStorage([BETTER_PROMPT_AUTH_STORAGE_KEY]).then(function(items) {
    const savedAuth = items[BETTER_PROMPT_AUTH_STORAGE_KEY] || {};
    authState = {
      sessionToken: typeof savedAuth.sessionToken === "string" ? savedAuth.sessionToken : "",
      user: savedAuth.user || null
    };
    return authState;
  });
}

function persistAuthState(sessionToken, user) {
  authState = {
    sessionToken: sessionToken,
    user: user || null
  };

  return writeExtensionStorage({
    [BETTER_PROMPT_AUTH_STORAGE_KEY]: authState
  });
}

function clearAuthState() {
  authState = {
    sessionToken: "",
    user: null
  };
  return removeExtensionStorage([BETTER_PROMPT_AUTH_STORAGE_KEY]);
}

function syncCurrentUser() {
  return loadStoredAuthState().then(function(state) {
    if (!state.sessionToken) {
      return authState;
    }

    return requestAuthorizedJson("/me", {
      method: "GET"
    }).then(function(payload) {
      authState.user = payload.user || null;
      return writeExtensionStorage({
        [BETTER_PROMPT_AUTH_STORAGE_KEY]: authState
      }).then(function() {
        return authState;
      });
    }).catch(function(error) {
      return clearAuthState().then(function() {
        throw error;
      });
    });
  });
}

function updateAuthUi(popupParts) {
  if (!popupParts || !popupParts.authStatus) {
    return;
  }

  if (authState.user) {
    popupParts.authStatus.textContent = authState.user.display_name + " 로그인됨";
    popupParts.loginButton.style.display = "none";
    popupParts.logoutButton.style.display = "";
  } else {
    popupParts.authStatus.textContent = "저장 기능을 쓰려면 로그인해 주세요.";
    popupParts.loginButton.style.display = "";
    popupParts.logoutButton.style.display = "none";
  }
}

function signInToBetterPrompt(popupParts) {
  if (popupParts && popupParts.authStatus) {
    popupParts.authStatus.textContent = "구글 로그인 중입니다...";
  }

  return sendRuntimeMessage({
    type: "better-prompt-google-sign-in",
    clientId: getGoogleClientId()
  }).then(function(response) {
    if (!response || !response.ok || !response.accessToken) {
      throw new Error(response && response.error ? response.error : "구글 로그인에 실패했습니다.");
    }

    return fetch(buildApiUrl("/auth/google"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        access_token: response.accessToken
      })
    });
  }).then(function(response) {
    if (!response.ok) {
      return normalizeFetchError(response).then(function(detail) {
        throw new Error(detail);
      });
    }

    return response.json();
  }).then(function(payload) {
    return persistAuthState(payload.session_token, payload.user).then(function() {
      updateAuthUi(popupParts);
      return authState;
    });
  }).catch(function(error) {
    updateAuthUi(popupParts);
    throw error;
  });
}

function logoutFromBetterPrompt(popupParts) {
  if (!authState.sessionToken) {
    return clearAuthState().then(function() {
      updateAuthUi(popupParts);
    });
  }

  return requestAuthorizedJson("/auth/logout", {
    method: "POST"
  }).catch(function(error) {
    console.warn("[Better Prompt] Logout request failed:", error);
  }).then(function() {
    return clearAuthState().then(function() {
      updateAuthUi(popupParts);
    });
  });
}

function ensureSignedIn(popupParts) {
  return syncCurrentUser().catch(function(error) {
    if (popupParts) {
      renderNoticeState(
        popupParts.resultsContainer,
        error instanceof Error ? error.message : "로그인 상태를 확인할 수 없습니다."
      );
    }
    return authState;
  }).then(function(state) {
    updateAuthUi(popupParts);
    if (state.user) {
      return state;
    }

    return signInToBetterPrompt(popupParts);
  });
}

function removeBetterPromptPopup() {
  const existingPopup = document.querySelector("#" + BETTER_PROMPT_POPUP_ID);

  if (existingPopup) {
    existingPopup.remove();
  }
}

function clearElement(element) {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

function createPopupSection(titleText) {
  const section = document.createElement("div");
  section.className = "better-prompt-popup-section";

  const title = document.createElement("p");
  title.className = "better-prompt-section-title";
  title.textContent = titleText;

  section.appendChild(title);
  return section;
}

function createButton(label, className, actionName) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  if (actionName) {
    button.setAttribute("data-action", actionName);
  }
  button.textContent = label;
  return button;
}

function renderMessageBlock(resultsContainer, titleText, message, blockClass) {
  if (!resultsContainer || !resultsContainer.isConnected) {
    return;
  }

  clearElement(resultsContainer);

  const section = createPopupSection(titleText);
  const block = document.createElement("div");
  block.className = blockClass;
  block.textContent = message;

  section.appendChild(block);
  resultsContainer.appendChild(section);
}

function renderLoadingState(resultsContainer) {
  renderMessageBlock(
    resultsContainer,
    "분석 결과",
    "프롬프트를 분석하고 있습니다...",
    "better-prompt-status"
  );
}

function renderErrorState(resultsContainer, message) {
  renderMessageBlock(resultsContainer, "오류 안내", message, "better-prompt-error-box");
}

function renderNoticeState(resultsContainer, message) {
  renderMessageBlock(resultsContainer, "안내", message, "better-prompt-status");
}

function renderIssues(issueListElement, issues) {
  issues.forEach(function(issue) {
    const issueItem = document.createElement("li");
    issueItem.className = "better-prompt-issue-item";

    const issueTitle = document.createElement("strong");
    issueTitle.textContent = issue.type;

    const issueDescription = document.createElement("p");
    issueDescription.textContent = issue.description;

    issueItem.appendChild(issueTitle);
    issueItem.appendChild(issueDescription);
    issueListElement.appendChild(issueItem);
  });
}

function renderNoIssuesMessage(resultsContainer, improvedPrompt, originalPrompt) {
  if (!resultsContainer || !resultsContainer.isConnected) {
    return;
  }

  clearElement(resultsContainer);

  const resultSection = createPopupSection("분석 결과");
  const resultBlock = document.createElement("div");
  resultBlock.className = "better-prompt-status";
  resultBlock.textContent = isShortPrompt(originalPrompt)
    ? "짧은 인사말은 크게 개선되지 않을 수 있습니다."
    : "충분히 좋은 프롬프트입니다.";
  resultSection.appendChild(resultBlock);

  const improvedPromptSection = createPopupSection("추천 프롬프트");
  const improvedPromptElement = document.createElement("div");
  improvedPromptElement.className = "better-prompt-improved-prompt";
  improvedPromptElement.textContent = improvedPrompt || "";
  improvedPromptSection.appendChild(improvedPromptElement);

  resultsContainer.appendChild(resultSection);
  resultsContainer.appendChild(improvedPromptSection);
}

function renderAnalysisState(resultsContainer, analysisResult, originalPrompt) {
  if (!resultsContainer || !resultsContainer.isConnected) {
    return;
  }

  const issues = analysisResult && Array.isArray(analysisResult.issues)
    ? analysisResult.issues
    : [];
  const improvedPrompt = analysisResult && analysisResult.improved_prompt
    ? analysisResult.improved_prompt
    : "";

  if (issues.length === 0) {
    renderNoIssuesMessage(resultsContainer, improvedPrompt, originalPrompt);
    return;
  }

  clearElement(resultsContainer);

  const issuesSection = createPopupSection("문제점");
  const issueListElement = document.createElement("ul");
  issueListElement.className = "better-prompt-issue-list";
  issuesSection.appendChild(issueListElement);

  const improvedPromptSection = createPopupSection("개선 프롬프트");
  const improvedPromptElement = document.createElement("div");
  improvedPromptElement.className = "better-prompt-improved-prompt";
  improvedPromptElement.textContent = improvedPrompt;
  improvedPromptSection.appendChild(improvedPromptElement);

  resultsContainer.appendChild(issuesSection);
  resultsContainer.appendChild(improvedPromptSection);
  renderIssues(issueListElement, issues);
}

function setTriggerButtonBusy(isBusy) {
  const triggerButton = document.querySelector("#" + BETTER_PROMPT_BUTTON_ID);

  if (!triggerButton) {
    return;
  }

  triggerButton.disabled = isBusy;
  triggerButton.setAttribute("aria-busy", String(isBusy));
  triggerButton.classList.toggle("is-busy", isBusy);
  triggerButton.textContent = isBusy ? "⏳" : "✨";
}

function invalidateCurrentSession() {
  activeAnalysisSession = null;
  activeAnalysisRequestId += 1;
  isRequestInFlight = false;
  setTriggerButtonBusy(false);
}

function dismissActiveSession() {
  invalidateCurrentSession();
  removeBetterPromptPopup();
}

function createBetterPromptPopup(currentPrompt) {
  removeBetterPromptPopup();

  const popup = document.createElement("div");
  popup.id = BETTER_PROMPT_POPUP_ID;
  popup.className = "better-prompt-popup";

  const header = document.createElement("div");
  header.className = "better-prompt-popup-header";

  const headerTextGroup = document.createElement("div");
  headerTextGroup.className = "better-prompt-header-text-group";

  const title = document.createElement("h3");
  title.textContent = "Better Prompt";

  const titleNotice = document.createElement("p");
  titleNotice.className = "better-prompt-header-notice";
  titleNotice.textContent = "입력이 불명확하면 결과 품질이 저하될 수 있습니다.";

  const closeButton = createButton("✕", "better-prompt-close-button");
  closeButton.setAttribute("aria-label", "닫기");
  const headerControls = document.createElement("div");
  headerControls.className = "better-prompt-header-controls";
  const loginButton = createButton(
    "로그인",
    "better-prompt-tertiary-button better-prompt-header-button",
    "login"
  );
  const logoutButton = createButton(
    "로그아웃",
    "better-prompt-tertiary-button better-prompt-header-button",
    "logout"
  );

  headerTextGroup.appendChild(title);
  headerTextGroup.appendChild(titleNotice);
  header.appendChild(headerTextGroup);
  headerControls.appendChild(loginButton);
  headerControls.appendChild(logoutButton);
  headerControls.appendChild(closeButton);
  header.appendChild(headerControls);

  const currentPromptSection = createPopupSection("현재 프롬프트");
  const previewElement = document.createElement("div");
  previewElement.className = "better-prompt-preview";
  previewElement.textContent = currentPrompt || BETTER_PROMPT_EMPTY_PROMPT_MESSAGE;
  currentPromptSection.appendChild(previewElement);

  const resultsContainer = document.createElement("div");
  resultsContainer.className = "better-prompt-results";

  const actions = document.createElement("div");
  actions.className = "better-prompt-popup-actions";
  const keepButton = createButton("유지하기", "better-prompt-tertiary-button", "keep");
  const applyButton = createButton("개선 적용", "better-prompt-primary-button", "apply");
  applyButton.disabled = true;
  actions.appendChild(keepButton);
  actions.appendChild(applyButton);

  const authSection = createPopupSection("저장 기능");
  authSection.classList.add("better-prompt-storage-section");
  const authStatus = document.createElement("span");
  authStatus.className = "better-prompt-auth-status";
  const authActions = document.createElement("div");
  authActions.className = "better-prompt-storage-actions";
  const saveButton = createButton(
    "저장",
    "better-prompt-secondary-button better-prompt-tool-button",
    "save"
  );
  const loadButton = createButton(
    "불러오기",
    "better-prompt-secondary-button better-prompt-tool-button",
    "load"
  );
  authActions.appendChild(saveButton);
  authActions.appendChild(loadButton);
  authSection.appendChild(authStatus);
  authSection.appendChild(authActions);

  const saveFormSection = createPopupSection("프롬프트 저장");
  saveFormSection.classList.add("is-hidden");
  const saveForm = document.createElement("div");
  saveForm.className = "better-prompt-inline-form";
  const saveTitleInput = document.createElement("input");
  saveTitleInput.type = "text";
  saveTitleInput.className = "better-prompt-text-input";
  saveTitleInput.placeholder = "저장 이름";
  const saveContentInput = document.createElement("textarea");
  saveContentInput.className = "better-prompt-textarea";
  saveContentInput.placeholder = "저장할 프롬프트";
  const saveFormActions = document.createElement("div");
  saveFormActions.className = "better-prompt-inline-actions";
  const saveConfirmButton = createButton("저장 확인", "better-prompt-primary-button", "confirm-save");
  const saveCancelButton = createButton("취소", "better-prompt-secondary-button", "cancel-save");
  saveFormActions.appendChild(saveConfirmButton);
  saveFormActions.appendChild(saveCancelButton);
  saveForm.appendChild(saveTitleInput);
  saveForm.appendChild(saveContentInput);
  saveForm.appendChild(saveFormActions);
  saveFormSection.appendChild(saveForm);

  const savedPromptSection = createPopupSection("저장된 프롬프트");
  savedPromptSection.classList.add("is-hidden");
  const savedPromptList = document.createElement("div");
  savedPromptList.className = "better-prompt-saved-list";
  savedPromptSection.appendChild(savedPromptList);

  popup.appendChild(header);
  popup.appendChild(currentPromptSection);
  popup.appendChild(resultsContainer);
  popup.appendChild(actions);
  popup.appendChild(authSection);
  popup.appendChild(saveFormSection);
  popup.appendChild(savedPromptSection);

  document.body.appendChild(popup);

  const popupParts = {
    popup: popup,
    resultsContainer: resultsContainer,
    applyButton: applyButton,
    authStatus: authStatus,
    loginButton: loginButton,
    logoutButton: logoutButton,
    saveButton: saveButton,
    loadButton: loadButton,
    saveFormSection: saveFormSection,
    saveTitleInput: saveTitleInput,
    saveContentInput: saveContentInput,
    saveConfirmButton: saveConfirmButton,
    saveCancelButton: saveCancelButton,
    savedPromptSection: savedPromptSection,
    savedPromptList: savedPromptList,
    editingSavedPromptId: null,
    savedPromptsCache: [],
    selectedSavedPromptId: null
  };

  closeButton.addEventListener("click", function() {
    dismissActiveSession();
  });

  keepButton.addEventListener("click", function() {
    dismissActiveSession();
  });

  loginButton.addEventListener("click", function() {
    signInToBetterPrompt(popupParts).catch(function(error) {
      renderErrorState(
        resultsContainer,
        error instanceof Error ? error.message : "로그인에 실패했습니다."
      );
    });
  });

  logoutButton.addEventListener("click", function() {
    logoutFromBetterPrompt(popupParts);
  });

  saveButton.addEventListener("click", function() {
    openSaveForm(popupParts);
  });

  loadButton.addEventListener("click", function() {
    toggleSavedPromptList(popupParts);
  });

  saveCancelButton.addEventListener("click", function() {
    closeSaveForm(popupParts);
  });

  saveConfirmButton.addEventListener("click", function() {
    submitSavedPrompt(popupParts);
  });

  return popupParts;
}

function getCurrentSession(requestId) {
  return activeAnalysisSession && activeAnalysisSession.requestId === requestId
    ? activeAnalysisSession
    : null;
}

function getImprovedPromptForSaving() {
  if (activeAnalysisSession &&
      activeAnalysisSession.analysisResult &&
      activeAnalysisSession.analysisResult.improved_prompt) {
    return activeAnalysisSession.analysisResult.improved_prompt;
  }

  return "";
}

function openSaveForm(popupParts, savedPromptItem) {
  ensureSignedIn(popupParts).then(function() {
    const defaultContent = savedPromptItem
      ? savedPromptItem.content
      : getImprovedPromptForSaving();

    if (!defaultContent) {
      renderNoticeState(
        popupParts.resultsContainer,
        "저장하려면 먼저 개선 결과를 만들어 주세요."
      );
      return;
    }

    popupParts.editingSavedPromptId = savedPromptItem ? savedPromptItem.id : null;
    popupParts.saveTitleInput.value = savedPromptItem
      ? savedPromptItem.title
      : "";
    popupParts.saveContentInput.value = defaultContent;
    popupParts.saveFormSection.classList.remove("is-hidden");
    popupParts.saveTitleInput.focus();
  }).catch(function(error) {
    renderErrorState(
      popupParts.resultsContainer,
      error instanceof Error ? error.message : "로그인이 필요합니다."
    );
  });
}

function closeSaveForm(popupParts) {
  popupParts.editingSavedPromptId = null;
  popupParts.saveTitleInput.value = "";
  popupParts.saveContentInput.value = "";
  popupParts.saveFormSection.classList.add("is-hidden");
}

function getSavedPromptSummary(content) {
  const normalized = normalizePromptText(content);
  if (!normalized) {
    return "";
  }

  return normalized.length > 72 ? normalized.slice(0, 72) + "..." : normalized;
}

function submitSavedPrompt(popupParts) {
  const nextTitle = popupParts.saveTitleInput.value.trim();
  const nextContent = popupParts.saveContentInput.value.trim();
  const editingSavedPromptId = popupParts.editingSavedPromptId;

  if (!nextTitle || !nextContent) {
    renderNoticeState(
      popupParts.resultsContainer,
      "저장 이름과 프롬프트 내용을 모두 입력해 주세요."
    );
    return;
  }

  ensureSignedIn(popupParts).then(function() {
    const path = editingSavedPromptId
      ? "/saved-prompts/" + editingSavedPromptId
      : "/saved-prompts";
    const method = editingSavedPromptId ? "PATCH" : "POST";

    return requestAuthorizedJson(path, {
      method: method,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title: nextTitle,
        content: nextContent
      })
    });
  }).then(function() {
    closeSaveForm(popupParts);
    popupParts.selectedSavedPromptId = null;
    renderNoticeState(
      popupParts.resultsContainer,
      editingSavedPromptId ? "저장된 프롬프트를 수정했습니다." : "프롬프트를 저장했습니다."
    );
    return loadSavedPrompts(popupParts);
  }).catch(function(error) {
    renderErrorState(
      popupParts.resultsContainer,
      error instanceof Error ? error.message : "프롬프트 저장에 실패했습니다."
    );
  });
}

function renderSavedPromptList(popupParts, savedPrompts) {
  popupParts.savedPromptsCache = savedPrompts.slice();
  clearElement(popupParts.savedPromptList);

  if (!savedPrompts.length) {
    popupParts.selectedSavedPromptId = null;
    const emptyMessage = document.createElement("div");
    emptyMessage.className = "better-prompt-status";
    emptyMessage.textContent = "저장된 프롬프트가 없습니다.";
    popupParts.savedPromptList.appendChild(emptyMessage);
    return;
  }

  const selectedPrompt = popupParts.selectedSavedPromptId
    ? savedPrompts.find(function(item) {
        return item.id === popupParts.selectedSavedPromptId;
      })
    : null;

  if (!selectedPrompt) {
    popupParts.selectedSavedPromptId = null;
    savedPrompts.forEach(function(item) {
      const itemButton = document.createElement("button");
      itemButton.type = "button";
      itemButton.className = "better-prompt-saved-item";

      const itemTitle = document.createElement("strong");
      itemTitle.textContent = item.title;

      const itemSummary = document.createElement("span");
      itemSummary.textContent = getSavedPromptSummary(item.content);

      itemButton.appendChild(itemTitle);
      itemButton.appendChild(itemSummary);
      itemButton.addEventListener("click", function() {
        popupParts.selectedSavedPromptId = item.id;
        renderSavedPromptList(popupParts, popupParts.savedPromptsCache);
      });

      popupParts.savedPromptList.appendChild(itemButton);
    });
    return;
  }

  const card = document.createElement("div");
  card.className = "better-prompt-saved-card";

  const cardTitle = document.createElement("strong");
  cardTitle.textContent = selectedPrompt.title;

  const cardContent = document.createElement("div");
  cardContent.className = "better-prompt-saved-preview";
  cardContent.textContent = selectedPrompt.content;

  const actionRow = document.createElement("div");
  actionRow.className = "better-prompt-action-grid";
  const applyButton = createButton("적용", "better-prompt-secondary-button");
  const editButton = createButton("수정", "better-prompt-secondary-button");
  const deleteButton = createButton("삭제", "better-prompt-secondary-button");
  const backButton = createButton("뒤로가기", "better-prompt-secondary-button");

  applyButton.addEventListener("click", function() {
    const inputElement = getPromptInputElement();
    if (!inputElement) {
      renderNoticeState(
        popupParts.resultsContainer,
        "현재 입력창을 찾을 수 없습니다."
      );
      return;
    }

    setPromptText(inputElement, selectedPrompt.content);
    inputElement.focus();
    dismissActiveSession();
  });

  editButton.addEventListener("click", function() {
    openSaveForm(popupParts, selectedPrompt);
  });

  deleteButton.addEventListener("click", function() {
    if (!window.confirm("이 저장 프롬프트를 삭제할까요?")) {
      return;
    }

    requestAuthorizedJson("/saved-prompts/" + selectedPrompt.id, {
      method: "DELETE"
    }).then(function() {
      popupParts.selectedSavedPromptId = null;
      renderNoticeState(popupParts.resultsContainer, "저장된 프롬프트를 삭제했습니다.");
      return loadSavedPrompts(popupParts);
    }).catch(function(error) {
      renderErrorState(
        popupParts.resultsContainer,
        error instanceof Error ? error.message : "삭제에 실패했습니다."
      );
    });
  });

  backButton.addEventListener("click", function() {
    popupParts.selectedSavedPromptId = null;
    renderSavedPromptList(popupParts, popupParts.savedPromptsCache);
  });

  actionRow.appendChild(applyButton);
  actionRow.appendChild(editButton);
  actionRow.appendChild(deleteButton);
  actionRow.appendChild(backButton);
  card.appendChild(cardTitle);
  card.appendChild(cardContent);
  card.appendChild(actionRow);
  popupParts.savedPromptList.appendChild(card);
}

function loadSavedPrompts(popupParts) {
  return ensureSignedIn(popupParts).then(function() {
    popupParts.savedPromptSection.classList.remove("is-hidden");
    popupParts.savedPromptList.innerHTML =
      '<div class="better-prompt-status">저장된 프롬프트를 불러오고 있습니다...</div>';

    return requestAuthorizedJson("/saved-prompts", {
      method: "GET"
    });
  }).then(function(savedPrompts) {
    renderSavedPromptList(popupParts, Array.isArray(savedPrompts) ? savedPrompts : []);
  }).catch(function(error) {
    renderErrorState(
      popupParts.resultsContainer,
      error instanceof Error ? error.message : "저장된 프롬프트를 불러오지 못했습니다."
    );
  });
}

function toggleSavedPromptList(popupParts) {
  if (!popupParts.savedPromptSection.classList.contains("is-hidden")) {
    if (popupParts.selectedSavedPromptId) {
      popupParts.selectedSavedPromptId = null;
      renderSavedPromptList(popupParts, popupParts.savedPromptsCache);
      return;
    }

    popupParts.savedPromptSection.classList.add("is-hidden");
    return;
  }

  popupParts.selectedSavedPromptId = null;
  loadSavedPrompts(popupParts);
}

function hydratePopupAuthState(popupParts) {
  syncCurrentUser().then(function() {
    updateAuthUi(popupParts);
  }).catch(function(error) {
    updateAuthUi(popupParts);
    console.debug("[Better Prompt] Auth sync skipped:", error);
  });
}

function handleBetterPromptClick(inputElement) {
  if (isRequestInFlight) {
    return;
  }

  const promptText = getPromptText(inputElement);
  console.log("[Better Prompt] Current prompt:", promptText);

  const popupParts = createBetterPromptPopup(promptText);
  hydratePopupAuthState(popupParts);

  if (!promptText) {
    activeAnalysisSession = null;
    renderNoticeState(popupParts.resultsContainer, "프롬프트를 먼저 입력해 주세요.");
    return;
  }

  if (shouldGuideForShortPrompt(promptText)) {
    activeAnalysisSession = null;
    renderNoticeState(
      popupParts.resultsContainer,
      "짧은 입력은 크게 개선되지 않을 수 있습니다. 15자 이상으로 써 주세요."
    );
    return;
  }

  const requestId = ++activeAnalysisRequestId;

  activeAnalysisSession = {
    requestId: requestId,
    inputElement: inputElement,
    promptSnapshot: promptText,
    popupParts: popupParts,
    analysisResult: null
  };

  isRequestInFlight = true;
  setTriggerButtonBusy(true);
  renderLoadingState(popupParts.resultsContainer);

  requestPromptImprovement(promptText).then(function(analysisResult) {
    const currentSession = getCurrentSession(requestId);

    if (!currentSession || !currentSession.popupParts.resultsContainer.isConnected) {
      return;
    }

    currentSession.analysisResult = analysisResult;
    renderAnalysisState(
      currentSession.popupParts.resultsContainer,
      analysisResult,
      currentSession.promptSnapshot
    );
    currentSession.popupParts.applyButton.disabled = false;
    currentSession.popupParts.applyButton.addEventListener(
      "click",
      function() {
        const latestSession = getCurrentSession(requestId);

        if (!latestSession || !latestSession.popupParts.resultsContainer.isConnected) {
          return;
        }

        const currentPrompt = getPromptText(latestSession.inputElement);
        if (currentPrompt !== latestSession.promptSnapshot) {
          renderNoticeState(
            latestSession.popupParts.resultsContainer,
            BETTER_PROMPT_STALE_PROMPT_MESSAGE
          );
          return;
        }

        const improvedPrompt = latestSession.analysisResult &&
          latestSession.analysisResult.improved_prompt
          ? latestSession.analysisResult.improved_prompt
          : "";

        setPromptText(latestSession.inputElement, improvedPrompt);
        latestSession.inputElement.focus();
        dismissActiveSession();
      },
      { once: true }
    );
  }).catch(function(error) {
    const currentSession = getCurrentSession(requestId);

    if (!currentSession || !currentSession.popupParts.resultsContainer.isConnected) {
      return;
    }

    console.error("[Better Prompt] Failed to improve prompt:", error);
    renderErrorState(
      currentSession.popupParts.resultsContainer,
      error instanceof Error ? error.message : "백엔드 서버에 연결할 수 없습니다."
    );
  }).then(function() {
    if (getCurrentSession(requestId)) {
      isRequestInFlight = false;
      setTriggerButtonBusy(false);
    }
  });
}

function injectBetterPromptButton() {
  const inputElement = getPromptInputElement();

  if (!inputElement) {
    return;
  }

  const inputWrapper = getPromptInputContainer(inputElement);

  if (!inputWrapper) {
    return;
  }

  if (inputWrapper.querySelector("#" + BETTER_PROMPT_BUTTON_ID)) {
    updateButtonLayout(inputWrapper);
    return;
  }

  inputWrapper.classList.add(BETTER_PROMPT_WRAPPER_CLASS);
  updateButtonLayout(inputWrapper);

  const button = document.createElement("button");
  button.id = BETTER_PROMPT_BUTTON_ID;
  button.type = "button";
  button.className = "better-prompt-button";
  button.textContent = "✨";
  button.title = "Better Prompt";
  button.setAttribute("aria-label", "Better Prompt");

  button.addEventListener("click", function() {
    const latestInput = getPromptInputElement();

    if (!latestInput || isRequestInFlight) {
      return;
    }

    handleBetterPromptClick(latestInput);
  });

  inputWrapper.appendChild(button);
  updateButtonLayout(inputWrapper);
}

function startBetterPrompt() {
  injectBetterPromptButton();

  const observer = new MutationObserver(function() {
    injectBetterPromptButton();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

startBetterPrompt();
