# HOP AI Agent — 프로젝트 의도

Tauri 2 기반 HWP 편집기(HOP)에 MS Word Copilot 수준의 인라인 AI 편집 사이드바를 만드는 프로젝트.

## 이미 구현됨

- ActionScript 기반 본문/표 셀(중첩 포함) 편집 — INSERT_BEFORE/AFTER/REPLACE/DELETE
- 표 생성(열 너비 가중치 col_weights), 페이지 나누기
- 이미지 삽입 — 첨부/URL/PDF 임베디드 추출/PDF 페이지 렌더+AI 크롭(macOS CoreGraphics)
- 질문/요약 모드(문서 비수정), 빠른 작업 칩, 선택 영역 인식 편집, 여러 변형 제안
- 시맨틱 문단 스타일(title/heading/body/caption/quote/emphasis) + 표 머리글 자동 테마
- 글쓰기 스킬(.md 프런트매터, 자동 트리거 매칭 + 수동 선택)
- 다중 프로바이더: anthropic/openai/gemini/ollama/openai-compat/claude-cli/gemini-cli
- 채팅 첨부 추출: PDF(pdf-extract)/HWP(rhwp)/DOCX 네이티브 텍스트 추출
- 대화 히스토리 영속화

## 앞으로 만들 기능 (우선순위순)

1. **편집 단위별 수락/거절** — 현재 턴 전체 승인/거부만 존재. ai-diff의 edit 단위 모델을 활용해 변경 블록마다 개별 ✓/✗ 버튼.
2. **문서 전체 교정 패스** — Word Editor처럼 전체 스캔 → 이슈 목록 → 위치 점프 → 개별 수정 적용.
3. **문서 개요 인식** — 글자 크기/굵기/번호 패턴 휴리스틱으로 헤딩 추정, 목차 생성·장별 요약.
4. **글상자/도형 텍스트 직렬화 + 편집** — 현재 AI가 글상자를 아예 못 봄. 한국 공문서 핵심 공백.
5. **표 구조 편집** — 기존 표에 행/열 추가·삭제, 셀 병합.
6. **런 단위 부분 서식 편집** — "이 단어만 굵게/빨갛게" (현재는 문단 전체 시맨틱 스타일만).
7. **머리말/꼬리말/각주** 직렬화 + 편집.
8. **데이터 → 차트 이미지 생성 삽입** — 차트를 이미지로 렌더 후 insertPicture.
9. **Windows/Linux PDF 페이지 렌더** — pdfium 도입 (현재 macOS 전용).

## 제약 (불변)

- `third_party/rhwp`는 read-only git 서브모듈 — 패치 금지, 저장 후처리(hwp_table_fix.rs)로 우회.
- 표 삽입 로직 변경 시 `hwp_table_check.py`가 exit 0 될 때까지 검증 필수.
- pnpm은 corepack 경유, Rust는 `rustup run 1.95.0` (Homebrew cargo는 너무 오래됨).
- 글 품질은 LLM+프롬프트+스킬에서 나온다 — rhwp는 HWP에 넣는 '손', LLM이 '두뇌'.
