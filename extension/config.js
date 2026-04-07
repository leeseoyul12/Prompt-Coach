const BETTER_PROMPT_CONFIG = Object.freeze({
  // 공개 배포용 백엔드 주소를 여기 한 곳에서만 바꾼다.
  apiBaseUrl: "http://127.0.0.1:8000",
  apiUrl: "http://127.0.0.1:8000/improve",
  googleClientId: "832019467646-6vc4quoh73r2cgvdtgsraen7lpu34aql.apps.googleusercontent.com",
  promptSelectors: [
    "#prompt-textarea",
    'textarea[data-testid="prompt-textarea"]',
    'textarea[placeholder*="Message"]',
    '[contenteditable="true"][role="textbox"]'
  ]
});
// 배포 할거면 이렇게
// apiBaseUrl: "https://better-prompt-evp9.onrender.com",
// apiUrl: "https://better-prompt-evp9.onrender.com/improve",
// 테스트 할 거면 이렇게 
// apiBaseUrl: "http://127.0.0.1:8000",
// apiUrl: "http://127.0.0.1:8000/improve",ㅇ