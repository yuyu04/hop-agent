# HOP AI Agent & Cursor형 인라인 편집 시스템 — 구현 스펙 (Tauri 판)

> **대상:** Claude Code
> **목표:** HOP(Tauri 2 / Rust + TypeScript) 한글 문서 편집기에 Cursor형 인라인 AI 편집 기능을 구현한다. Agent Sidebar(스튜디오 호스트 UI)가 사용자 지시를 받아 LLM에 편집을 요청하고, 결과 Action Script를 가상 Diff로 렌더링한 뒤 사용자 승인 시에만 실제 `.hwp` 바이너리에 반영한다.
> **작업 원칙:** 아래 7개 챕터를 모듈 단위로 구현한다. 각 챕터는 독립 PR로 분리 가능하도록 설계할 것. 외부 LLM API 인증·과금 정책은 변동이 잦으니, provider 연동 코드 작성 전 각 사 공식 문서를 한 번 확인하고 진행한다.

---

## 0. 스택 정정 노트 (원본 스펙 대비 변경)

원본 스펙은 HOP를 **C++/Qt + QWebChannel** 앱으로 가정했으나, 실제 저장소는 **Tauri 2 (Rust + TypeScript)** 앱이다. 따라서 아래와 같이 개념을 실제 스택으로 번역하여 구현한다. 코드 시그니처는 모두 현재 저장소 컨벤션(`apps/desktop/src-tauri/src/commands.rs`, `apps/studio-host/src/core/tauri-bridge.ts`)을 따른다.

| 원본 스펙 (C++/Qt) | 실제 구현 (Tauri) | 비고 |
|---|---|---|
| `QWebChannel` / `window.hopBridge` 전역 객체 | Tauri `invoke()` 커맨드 + `app.emit` 이벤트 | 신규 객체 노출 없음. 기존 `TauriBridge`에 메서드 추가 |
| `HopAiBridge : public QObject` (`Q_INVOKABLE`) | `#[tauri::command]` 함수들 (`commands.rs` 또는 신규 `ai/` 모듈) | `lib.rs`의 `generate_handler!`에 등록 |
| `signals: streamDelta/editReady/editFailed` | `app.emit("hop-ai-...", payload)` + 프론트 `listen(...)` | 기존 `hop-job-progress` 패턴과 동일 |
| `ILlmProvider` C++ 추상 인터페이스 (`QFuture`) | Rust `trait LlmProvider` (`async-trait`) + `reqwest` 구현체 | 런타임 교체 가능 |
| React Agent Sidebar | `apps/studio-host/src/ui/agent-sidebar.ts` 바닐라 TS 모듈 | 현재 UI는 React가 아님(toolbar.ts 등과 동일 패턴) |
| C++ Graphics Layer Diff 오버레이 | `apps/studio-host/src/view/page-overlays.ts` 기반 SVG/DOM 오버레이 | 렌더는 rhwp WASM SVG 위에 그림 |
| 문서 직렬화/적용 (코어 직접 호출) | 기존 `query_document` / `mutate_document` 커맨드 재사용 + 신규 직렬화 커맨드 | rhwp `DocumentCore` 위에 구축 |
| OS 보안 저장소 (Keychain 등) | `keyring` crate 또는 Tauri secure-storage 플러그인 | 6장 |

**핵심 제약 (AGENTS.md):** `third_party/rhwp`는 읽기 전용. AI 동작은 전부 `apps/desktop`(Rust) 또는 `apps/studio-host`(TS)에 둔다. 크로스플랫폼(macOS/Windows/Linux) 동작 유지. 시크릿·문서 본문을 로그에 남기지 않는다.

---

## 1. 시스템 통신 아키텍처 (Tauri Bridge)

HOP UI(studio-host, TS)와 네이티브(Rust)는 Tauri IPC로 통신한다. 별도 `window.hopBridge` 전역을 새로 만들지 않고, 기존 `TauriBridge`(`apps/studio-host/src/core/tauri-bridge.ts`)에 AI 메서드를 추가하여 `invoke`/`listen`을 캡슐화한다.

기존 동기식 `bool applyActionScript` 시그니처는 **스트리밍·취소·타임아웃 처리가 불가능**하므로, 비동기 요청 + 이벤트 스트림 구조로 구현한다.

### 1.1 네이티브 커맨드 (Rust, `#[tauri::command]`)

신규 모듈 `apps/desktop/src-tauri/src/ai/mod.rs`(+ `provider.rs`, `serialize.rs`, `secrets.rs`)에 구현하고 `lib.rs`의 `generate_handler!`에 등록한다.

```rust
// apps/desktop/src-tauri/src/ai/mod.rs

/// 1. 현재 Viewport 중심 또는 전체 문서 컨텍스트 추출 (2장 직렬화 결과 + 세션 화이트리스트 등록)
#[tauri::command]
pub fn ai_get_document_context(
    doc_id: String,
    current_selection_only: bool,
    state: State<'_, AppState>,
) -> Result<DocumentContext, String>;

/// 2. 편집 요청 시작(비동기). request_id 즉시 반환, 결과는 이벤트로 전달.
#[tauri::command]
pub async fn ai_request_edit(
    app: AppHandle,
    doc_id: String,
    user_prompt: String,
    provider_id: String,
    model_id: String,
    state: State<'_, AppState>,
) -> Result<String, String>; // returns request_id

/// 3. 진행 중 요청 취소 (HTTP/subprocess 즉시 중단)
#[tauri::command]
pub fn ai_cancel_request(request_id: String, state: State<'_, AppState>) -> Result<(), String>;
```

> **참고:** 원본 스펙의 `applyActionScript`(가상 DOM 적용 + Diff 렌더)와 `finalizeTransaction`은 **프론트엔드(studio-host)에서 처리**한다. 가상 Diff는 화면 오버레이이므로 네이티브를 거칠 필요가 없다(4장). 승인(Accept) 시점에만 기존 `mutate_document` 커맨드로 코어에 반영한다.

### 1.2 이벤트 (Rust `app.emit` → TS `listen`)

`hop-job-progress`와 동일한 패턴. 페이로드는 `request_id`로 멀티 요청을 구분한다.

| 이벤트 이름 | 페이로드 | 의미 |
|---|---|---|
| `hop-ai-stream-delta` | `{ requestId, partialText }` | 부분 응답(스트리밍 텍스트) |
| `hop-ai-edit-ready` | `{ requestId, actionScriptJson }` | 검증 통과한 최종 Action Script |
| `hop-ai-edit-failed` | `{ requestId, reason, code }` | 실패(파싱/타임아웃/화이트리스트 위반 등) |

```rust
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamDelta { pub request_id: String, pub partial_text: String }
// app.emit("hop-ai-stream-delta", AiStreamDelta { .. })
```

### 1.3 프론트엔드 브리지 메서드 (`TauriBridge`)

```ts
// apps/studio-host/src/core/tauri-bridge.ts (DesktopBridgeApi에 추가)
export interface AiBridgeApi {
  aiGetDocumentContext(docId: string, currentSelectionOnly: boolean): Promise<DocumentContext>;
  aiRequestEdit(docId: string, userPrompt: string, providerId: string, modelId: string): Promise<string>;
  aiCancelRequest(requestId: string): Promise<void>;
}
```

스트림/완료 이벤트 구독은 `desktop-events.ts`의 `listen(...)` 등록부에 `hop-ai-*` 핸들러를 추가하여 Sidebar UI/상태 머신으로 라우팅한다.

---

## 2. 문서 직렬화 및 인덱싱 매핑 규칙

대용량 문서 대응 및 정확한 객체 타겟팅을 위해, `ai_get_document_context`는 rhwp `DocumentCore`를 순회하여 **계층적 세그먼트 ID(Path-based ID)** 를 동적으로 부여한 직렬화 결과를 LLM에 전달한다. (가능하면 기존 `query_document`의 읽기 경로를 재사용하고, 신규 쿼리가 필요하면 `serialize.rs`에 코어 순회 로직을 둔다. `third_party/rhwp`는 수정 금지.)

**LLM 피딩용 직렬화 JSON 포맷 (`DocumentContext`):**

```json
{
  "document_metadata": { "total_sections": 1, "current_cursor_path": "sec[0].p[2]" },
  "content": [
    { "id": "sec[0].p[0]", "type": "paragraph", "style": "Heading 1", "text": "1. 추진 배경" },
    { "id": "sec[0].p[1]", "type": "paragraph", "style": "Normal", "text": "기존 시스템의 노후화로 인한 업무 효율 저하가 발생함." },
    {
      "id": "sec[0].tbl[0]",
      "type": "table",
      "rows": 2,
      "cols": 2,
      "matrix": [
        ["구분", "내용"],
        ["AS-IS", "수작업 위주 프로세스"]
      ]
    },
    { "id": "sec[0].p[2]", "type": "paragraph", "style": "Normal", "text": "따라서 AI 기반의 고도화가 시급함." }
  ]
}
```

> **검증 요건:** 직렬화 시 부여한 모든 `id`를 **요청 단위 세션 화이트리스트**(`AppState` 내 `request_id → HashSet<String>`)로 보관한다. LLM 응답의 `target_id`가 이 목록에 없으면 환각으로 간주하고 해당 edit을 거부한다 (7장 참조). 화이트리스트는 `ai_request_edit` 시작 시 생성하고, 트랜잭션 종료/취소 시 정리한다.

> **ID 안정성:** Path-based ID는 직렬화 시점의 스냅샷이다. 적용(Accept) 시 문서 revision이 직렬화 시점과 달라졌으면(`mutate_document`의 `expected_revision` 불일치) 거부하고 재요청을 안내한다.

---

## 3. LLM Action Script 출력 스키마

LLM은 자연어 설명을 배제하고 아래 JSON Schema를 만족하는 Raw JSON만 반환한다. Rust 측은 `serde`로 역직렬화되는 타입(`ActionScript { edits: Vec<Edit> }`)으로 모델링한다.

**중요:** "Markdown Code Block 금지"를 System Prompt 문구로만 강제하지 말 것. 각 provider의 **네이티브 구조화 출력 기능**(5장)에 이 스키마를 그대로 주입하여 포맷을 강제한다.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "edits": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "command": { "type": "string", "enum": ["INSERT_BEFORE", "INSERT_AFTER", "REPLACE", "DELETE"] },
          "target_id": { "type": "string", "description": "HOP 문서 호스트가 제공한 고유 ID (예: sec[0].p[1])" },
          "payload": {
            "type": "object",
            "properties": {
              "type": { "type": "string", "enum": ["paragraph", "table"] },
              "text": { "type": "string" },
              "style": { "type": "string" },
              "table_data": {
                "type": "object",
                "properties": {
                  "rows": { "type": "integer" },
                  "cols": { "type": "integer" },
                  "matrix": { "type": "array", "items": { "type": "array", "items": { "type": "string" } } }
                }
              }
            }
          }
        },
        "required": ["command", "target_id", "payload"]
      }
    }
  },
  "required": ["edits"]
}
```

```rust
// apps/desktop/src-tauri/src/ai/schema.rs
#[derive(Debug, Deserialize, Serialize)]
pub struct ActionScript { pub edits: Vec<Edit> }

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub command: EditCommand, // INSERT_BEFORE | INSERT_AFTER | REPLACE | DELETE
    pub target_id: String,
    pub payload: EditPayload,
}
```

> 스키마는 단일 소스로 두고(예: `ai/schema.rs`의 정적 JSON 또는 `serde_json` 빌더), 5장 provider 어댑터가 각 사 네이티브 형식으로 변환·주입한다.

---

## 4. 실시간 인라인 Diff 및 예외 처리

**가상 렌더링(Virtual Overlay-Diff):** Action Script 수신 시 studio-host가 현재 rhwp SVG 페이지 렌더 위에 **오버레이 레이어**(`apps/studio-host/src/view/page-overlays.ts` 확장)를 그린다. 실제 코어/`.hwp`는 건드리지 않는다.

- `REPLACE`/`DELETE` 대상 원본 객체: **취소선 + 배경색 RGB(255,221,221)** 임시 표시.
- `INSERT` 신규 객체: **밑줄 + 배경색 RGB(221,255,221)** 임시 표시.
- 사용자가 승인하기 전까지 실제 `.hwp` 바이너리에 저장하지 않는 **휘발성 상태(Transient State)** 유지. 상태는 Sidebar/오버레이의 TS 메모리에만 존재.

**Accept / Reject (프론트 트랜잭션 확정):**
- **Accept:** 보류 중인 각 edit을 기존 `mutate_document` 호출(들)로 코어에 반영(`expected_revision` 동봉). 성공 후 오버레이 제거 + `markDocumentDirty()`.
- **Reject:** 오버레이만 제거하고 상태 폐기. 코어 변경 없음.

**동시성 처리:** Diff 미확정(`DIFF_PENDING`) 상태에서 새 `aiRequestEdit`가 들어오면 기존 트랜잭션을 자동 Reject(롤백) 후 신규 요청을 처리한다. 동시에 둘 이상의 미확정 Diff가 화면에 중첩되지 않도록 상태 머신(7장)으로 보장한다.

**대용량 문서 — Sliding Window:** 전체 문서가 **3만 자**를 초과하면, 커서 기준 **앞 5문단 + 뒤 5문단 + 전체 Heading(목차)** 만 조합하여 컨텍스트로 전달, 토큰 낭비를 방지한다. (`ai_get_document_context`가 `current_selection_only`/문서 크기에 따라 윈도잉.)

**JSON 파싱 에러 방어:** LLM 응답이 불완전하거나 포맷이 깨지면 `hop-ai-edit-failed`(`code: "PARSE_ERROR"`)로 종료하고, Sidebar UI에서 `개조식 문장 변환 실패: 정형화된 데이터를 수신하지 못했습니다.` 메시지를 노출한다. 부분 스트림은 참고용 텍스트로만 보여주고 코어에는 적용하지 않는다.

---

## 5. AI Provider 연동 규격

### 5.1 Provider 추상화 인터페이스 (Rust trait)

각 사 API는 엔드포인트·인증·응답 포맷이 다르므로 **어댑터 패턴**으로 흡수한다. AI 코어는 `LlmProvider` trait만 의존한다. HTTP는 `reqwest`, 스트리밍 델타는 채널/콜백으로 `app.emit("hop-ai-stream-delta", ..)`에 연결한다.

```rust
// apps/desktop/src-tauri/src/ai/provider.rs
pub struct LlmRequest {
    pub system_prompt: String,
    pub user_prompt: String,
    pub document_context_json: String, // 2장 직렬화 결과
    pub output_schema: serde_json::Value, // 3장 스키마
    pub model_id: String,
}

#[async_trait::async_trait]
pub trait LlmProvider: Send + Sync {
    /// 스트리밍 델타는 on_delta 콜백으로, 최종(미검증) Action Script JSON 문자열은 반환값으로 전달.
    /// 취소는 CancellationToken으로 협조적 중단.
    async fn generate_edit(
        &self,
        req: LlmRequest,
        on_delta: &(dyn Fn(String) + Send + Sync),
        cancel: CancellationToken,
    ) -> Result<String, ProviderError>;
}
```

> 화이트리스트/스키마 검증은 provider 바깥(AI 코어)에서 수행한다. provider는 "원문 JSON 문자열"까지만 책임진다.

### 5.2 Provider별 매핑

| Provider | Base URL | 인증 헤더 | 구조화 출력 강제 방식 |
|---|---|---|---|
| **Anthropic (Claude)** | `https://api.anthropic.com/v1/messages` | `x-api-key` + `anthropic-version: 2023-06-01` | `tools`에 스키마 정의 + `tool_choice`로 해당 tool 강제 호출 |
| **OpenAI (GPT)** | `https://api.openai.com/v1/chat/completions` (또는 `/v1/responses`) | `Authorization: Bearer <key>` | `response_format: { type: "json_schema", json_schema: {...}, strict: true }` |
| **Google (Gemini)** | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `x-goog-api-key: <key>` | `generationConfig.responseMimeType: "application/json"` + `responseSchema` |

> 핵심: 3장의 JSON Schema를 각 provider 네이티브 형식으로 변환·주입하면 프롬프트 문구로 JSON을 강제할 필요가 없어지고 파싱 에러가 크게 줄어든다.

### 5.3 최신 연동 방식 (API 키 직접 입력 외)

데스크톱 앱에서 키 유출 위험을 줄이고 구독을 활용하기 위한 대안 연동 방식. **각 방식의 인증·과금 정책은 변동이 잦으므로 구현 전 공식 문서 확인 필수.**

1. **CLI 위임 방식** — 사용자가 이미 로그인해 둔 로컬 CLI(Claude Code / Codex CLI / Gemini CLI)를 HOP가 Rust `std::process`/`tauri-plugin-shell`로 호출. CLI가 OAuth 토큰·구독을 처리하므로 앱이 API 키를 직접 다루지 않는다.
2. **OAuth Device Flow** — 앱 내/시스템 브라우저로 로그인 → 토큰 수신. 사용자가 API 키를 평문 입력할 필요 없음.
3. **로컬 모델 (Ollama / LM Studio)** — `http://localhost:11434/v1/chat/completions` (OpenAI 호환). 공문서를 외부로 보내면 안 되는 경우 필수. OpenAI 호환 엔드포인트라 OpenAI 어댑터를 재사용한다.
4. **OpenAI 호환 게이트웨이 (LiteLLM 등)** — 사내 프록시 1개로 멀티 provider 라우팅 + 키 중앙 관리 + 호출 로깅. HOP는 게이트웨이 단일 엔드포인트만 바라본다.

각 방식은 `LlmProvider` 구현체(`AnthropicProvider`, `OpenAiProvider`, `GeminiProvider`, `ClaudeCliProvider`, `OllamaProvider`, `GatewayProvider` 등)로 캡슐화하여 `provider_id`로 런타임 교체 가능하도록 한다.

---

## 6. 인증 및 보안

- **API 키 저장:** 평문 파일/설정 저장 절대 금지. OS 보안 저장소 사용 — macOS Keychain, Windows Credential Manager, Linux Secret Service. Rust `keyring` crate(또는 동등 Tauri 보안 저장 플러그인)로 `ai/secrets.rs`에 캡슐화. 키는 메모리에서도 최소 수명 유지, **로그·에러 메시지에 절대 출력 금지**(AGENTS.md).
- **연동 옵션 선택:** API 키 / CLI 위임 / OAuth / 로컬 모델 중 사용자·관리자가 선택. 기업 배포 시 관리자 정책으로 강제 가능하도록 설계.
- **공문서 보호:** 문서가 민감/기밀로 분류된 경우 **외부 provider 전송을 차단하고 로컬 모델만 허용**하는 옵션 제공. 필요 시 전송 전 개인정보·고유식별자 마스킹 단계 삽입.
- **전송 범위 최소화:** Sliding Window(4장)로 필요한 컨텍스트만 전송하여 외부 노출 면적을 줄인다.
- **커맨드 권한:** 신규 `ai_*` 커맨드는 `apps/desktop/src-tauri/capabilities/`의 권한 정책에 명시적으로 추가한다.

---

## 7. 요청 생명주기

1. **스트리밍:** `hop-ai-stream-delta` 이벤트로 부분 응답을 Sidebar에 실시간 표시.
2. **취소:** `ai_cancel_request` 호출 시 `CancellationToken`으로 진행 중 HTTP 요청/subprocess를 즉시 중단하고 미적용 상태로 정리.
3. **타임아웃:** provider 응답 지연 시 `reqwest` 타임아웃 경과 후 `hop-ai-edit-failed`(`code: "TIMEOUT"`)로 종료하고 재시도 안내.
4. **`target_id` 화이트리스트 검증:** Action Script의 모든 `target_id`를 2장 화이트리스트와 대조. 미존재 ID가 포함된 edit은 거부하고 해당 항목만 스킵하거나, 전체 거부 후 `hop-ai-edit-failed` 처리(정책 선택 — 기본은 **전체 거부**로 안전 우선).
5. **트랜잭션 상태 머신 (studio-host 측):** `IDLE → REQUESTING → DIFF_PENDING → (FINALIZED | ROLLED_BACK)`. 각 전이 외의 입력은 무시하거나 명확히 거부한다. `REQUESTING` 중 취소는 `IDLE`로, `DIFF_PENDING` 중 새 요청은 자동 `ROLLED_BACK` 후 `REQUESTING`으로.

---

## 8. 구현 순서 (PR 분해)

- **PR1 — Ch1·2·3 기반(첫 PR, 권장 시작점):**
  - Rust: `ai/mod.rs` 커맨드 골격(`ai_get_document_context`/`ai_request_edit`/`ai_cancel_request`), `ai/schema.rs`(ActionScript 타입), `ai/serialize.rs`(Path-based ID 직렬화 + 화이트리스트), `lib.rs` 등록, `capabilities` 권한.
  - TS: `TauriBridge`에 `aiGetDocumentContext`/`aiRequestEdit`/`aiCancelRequest` + `hop-ai-*` 이벤트 라우팅 골격.
  - 이 단계에서 provider는 **목(mock) 구현** 하나로 두고, 직렬화/스키마/이벤트/화이트리스트 경로를 테스트로 고정.
- **PR2 — Ch5·6:** `LlmProvider` trait + Anthropic/OpenAI/Gemini/Ollama 어댑터, `keyring` 비밀 저장.
- **PR3 — Ch4·7:** 오버레이 Diff 렌더, 상태 머신, Accept→`mutate_document` 반영, 취소/타임아웃 전 경로.
- **PR4 — Sidebar UI:** `agent-sidebar.ts` 입력/스트림/Accept·Reject UI.

각 PR은 `pnpm run test:desktop`(cargo test) / `pnpm run test:studio`(vitest) / `pnpm run clippy:desktop` 통과를 조건으로 한다.
