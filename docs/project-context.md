<!-- Cladding · Tier B · SSoT — intent + Why/What/Purpose · Refreshed by: clad refine / manual -->

# hop-agent — Project Context

## 1. Why does this project exist?

한국 공공·기업 문서의 표준 포맷인 HWP는 MS Word와 달리 Copilot 같은 인라인 AI 편집 도구가 없다.
HOP(Tauri 2 + rhwp WASM 기반 HWP 편집기)에 **MS Word Copilot 수준의 AI 사이드바**를 붙여,
사용자가 자연어로 "이 표 채워줘", "격식있게 고쳐줘"라고 말하면 문서가 직접 수정되는 경험을 만든다.

핵심 설계 원칙: **글 품질은 LLM+프롬프트+스킬에서 나온다** — rhwp는 HWP에 넣는 '손', LLM이 '두뇌'.

## 2. What problem does it solve?

- HWP 문서를 AI가 **볼 수 있게**: 본문/표 셀(중첩 포함)을 경로 기반 id로 직렬화 (Rust `apps/desktop/src-tauri/src/ai/serialize.rs`)
- AI 응답(ActionScript: INSERT/REPLACE/DELETE + 표/이미지/스타일 payload)을 **적용할 수 있게**: WASM 편집 프리미티브 경유 (TS `apps/studio-host/src/core/ai-apply.ts`)
- 수정 전 **검토할 수 있게**: diff 하이라이트 + 승인/거부 세션 머신 (`ai-diff.ts`, `ai-session.ts`, `ui/agent-sidebar.ts`)
- 프로바이더 중립: anthropic/openai/gemini/ollama/openai-compat/claude-cli/gemini-cli

남은 공백(= `spec/features/`의 planned 항목들): 편집 단위별 수락/거절, 문서 전체 교정 패스,
개요 인식, 글상자/표 구조/머리말·각주 편집, 런 단위 서식, 차트 생성, 비-macOS PDF 렌더.

## 3. What is its purpose?

HWP 사용자에게 Word Copilot 동등 경험 제공. 새 기능 제안의 판단 기준은 **"Copilot이 하는가?"**.

### 불변 제약

- `third_party/rhwp`는 read-only git 서브모듈 — 패치 금지, 저장 후처리(`hwp_table_fix.rs`)로 우회
- 표 삽입 로직 변경 시 `hwp_table_check.py` exit 0까지 검증 필수
- pnpm은 corepack 경유, Rust는 `rustup run 1.95.0`

## See also

- `docs/cladding-intent.md` — 온보딩 의도 원문 (구현 완료/예정 기능 전체 목록)
- `docs/conventions.md` — observed code conventions
- `spec/architecture.yaml` — observed layers
- `spec/capabilities.yaml` — capability → feature 바인딩
- `spec.yaml` — feature registry
