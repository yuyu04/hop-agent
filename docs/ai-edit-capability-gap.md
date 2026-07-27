# HOP AI 편집 기능 격차 — "한글 문서를 AI로 고친다"에 무엇이 빠졌나

> 작성 2026-07-27 · **갱신 2026-07-27 (1단계 5개 구현 완료)** · 실측 기준 HEAD `126ee1b`
> 목적: 오픈소스 HOP의 **기존 사용자**가 지금 손으로 하는 한글 문서 작업을
> AI에게 시킬 수 있게 하려면 무엇을 채워야 하는지, 코드 근거와 함께 정리.
>
> 배포·과금 관점은 이 문서 범위 밖이다 → [`competitive-gap-inline-ai.md`](./competitive-gap-inline-ai.md)
>
> **이 문서는 docs 산출물이지 spec이 아니다.** 실제로 만들기로 한 항목만 그때
> `clad create-feature`로 shard를 만든다(코드보다 먼저 쓰면 `PLANNED_BACKLOG`에 걸림).

---

## 0. 결론부터 — 격차의 성격

**빠진 건 모델 성능도, 엔진 기능도 아니다. AI가 닿을 수 있는 표면이다.**

세 숫자가 전부를 설명한다:

| | 최초 조사 | 현재 | 근거 |
|---|---|---|---|
| rhwp 엔진이 제공하는 문서 조작 메서드 | 약 270개 | 약 270개 | `vendor/rhwp-core/rhwp.d.ts` |
| 그중 AI 적용 파이프라인이 실제로 호출하는 것 | 약 46개 (17%) | **약 57개 (21%)** | `core/ai-apply.ts` 교차 대조 |
| LLM이 emit할 수 있는 편집 종류 | 7종 | **11종** | `ai/schema.rs:490` |

최초 7종: `paragraph` · `table` · `image` · `table_edit` · `clone_table` · `format` · `chart`
추가 4종(+`table_edit.split_cell`): `replace_text` · `table_formula` · `footnote` · `paste_html`

그리고 결정적으로 —

> **HOP 편집기는 사람이 손으로 하면 되는 일인데, AI에게는 시킬 수 없는 일이 많다.**
>
> - 찾아 바꾸기 → `ui/find-dialog.ts` **있음**. AI 경로에는 `replaceAll`/`searchText` 호출 **0건**
> - 번호매기기/불릿 → `ui/numbering-dialog.ts` **있음**. AI 경로 호출 **0건**
> - 도형 그리기 → `engine/input-handler.ts`에서 **가능**. AI 경로 호출 **0건**

기존 HOP 사용자 입장에서 이건 매우 이상한 경험이다. "메뉴에서는 되는데 AI한테 말하면 안 되네." **오픈소스 기여자 입장에서는 반대로 좋은 소식이다 — 엔진을 새로 만들 필요가 없고, 배선만 하면 된다.**

---

## 1. 지금 AI가 "보는" 문서 (인지 격차)

`serialize.rs`가 LLM에 넘기는 것은 사실상 **평평한 텍스트 목록**이다.

```
content: [{ id: "sec[0].p[3]", text: "...", heading?: 1|2|3 }, ...]
document_metadata: { total_sections, current_cursor_path?, form_tables[] }
```

id 체계는 꽤 넓다 (`serialize.rs:134,167,210,600`):

| 대상 | id 형식 | 보임 |
|---|---|---|
| 본문 문단 | `sec[S].p[P]` | ✅ |
| 표 셀 문단 · 글상자 | `sec[S].p[P].tbl[C].cell[N].p[I]` | ✅ |
| 머리말/꼬리말 | `sec[S].header\|footer[A].p[I]` | ✅ |
| 각주 | `sec[S].p[P].fn[C].p[I]` | ✅ |
| 최상위 표 구조(행·열·셀 역할) | `form_tables[]` | ✅ (중첩 표는 제외, `:679`) |

**보이지 않는 것 — 여기가 인지 격차다:**

| 안 보이는 것 | 그래서 못 하는 요청 |
|---|---|
| **문단별 서식** (글꼴·크기·색·굵기·정렬·줄간격) | "위 문단이랑 같은 서식으로 맞춰줘", "이 문서에서 글꼴 튀는 데 찾아줘" |
| **스타일 이름** (개요1, 본문, 바탕글…) | "전부 '본문' 스타일로 통일해줘" |
| **번호매기기/불릿 여부** | "번호 순서 틀린 데 고쳐줘" — 번호가 자동인지 손으로 친 글자인지 구분 불가 |
| **페이지·구역 레이아웃** (쪽수, 여백, 용지 방향, 단) | "2쪽에 있는 표를…", "가로로 돌려줘", "2단으로 나눠줘" |
| **그림·도형 목록** (무엇이 어디에) | "그림 3개 크기 맞춰줘", "표 위에 있는 그림 지워줘" |
| **누름틀(필드) 목록** | "빈 누름틀 다 채워줘" |
| **메모·책갈피·하이퍼링크** | "메모 달린 곳 정리해줘" |
| **중첩 표** (`:679`에서 명시적 제외) | 표 안의 표 구조 편집 |
| **변경 이력/교정 부호** | "내가 뭘 바꿨는지 요약해줘" |

heading 힌트(F-0858f2)는 글자 크기·굵기 **휴리스틱 추정**이지 실제 스타일 정보가 아니다. 폰트 신호가 균일하면 아무것도 못 낸다(`serialize.rs:983` 테스트).

---

## 2. 지금 AI가 "시킬 수 있는" 것 (행위 격차)

엔진에는 있는데 AI 경로에서 **호출 0건**인 기능들. 사용자 요청 예시와 함께.

### 우선순위 1 — 가장 자주 요청받는데 없는 것

#### ① 찾아 바꾸기 (`replaceAll` / `replaceOne` / `replaceText` / `searchText` / `searchAllText`)  ✅ **구현됨 (F-293e8c99)**
- 사용자: **"문서 전체에서 '2025년'을 '2026년'으로 바꿔줘"**
- 지금: AI가 해당 문단을 **하나씩** 찾아 `REPLACE` edit를 문단 수만큼 생성해야 한다. 100군데면 edit 100개 → 토큰 폭증, 누락 발생, 승인 UI 도배
- 엔진: 이미 있고 편집기 UI(`find-dialog.ts`)가 쓰고 있다
- 규모: **작음.** payload 1종(`replace_text`) 추가 + 배선
- 비고: 이게 안 되는 게 현재 가장 큰 실용 격차다. 문서 편집 AI에게 제일 흔한 요청이다

#### ② 번호매기기 / 불릿 (`createNumbering` / `ensureDefaultNumbering` / `ensureDefaultBullet` / `insertNewNumber` / `setNumberingRestart`)
- 사용자: **"1. 가. 1) 가) 순서로 번호 매겨줘"**, "번호 다시 1부터 시작"
- 지금: AI가 `"1. "`, `"가. "`를 **글자로 타이핑**해 넣는다. 항목을 하나 지우면 번호가 전부 어긋난다
- 엔진: 있음 (`numbering-dialog.ts`가 사용)
- 규모: 중간. 한글 공문서 번호 체계(1./가./1)/가)/①) 매핑 설계 필요
- 비고: **한국 공문서의 핵심.** 이게 없으면 "공문서 AI"라고 하기 어렵다

#### ③ 스타일 (`createStyle` / `updateStyle` / `deleteStyle`)
- 사용자: **"제목은 전부 개요1 스타일로"**, "본문 스타일 글꼴만 바꿔줘"
- 지금: `applyStyle`(기존 스타일 적용)만 AI가 쓸 수 있다. 스타일을 **만들거나 고칠 수 없고**, 애초에 문서에 어떤 스타일이 있는지 컨텍스트에 없다
- 엔진: 있음 (`style-edit-dialog.ts:242`가 사용)
- 규모: 작음(적용) ~ 중간(생성/수정). **먼저 컨텍스트에 스타일 목록을 실어야 한다**

#### ④ 문단·범위 원자 연산 (`insertParagraph` / `deleteParagraph` / `deleteRange` / `deleteRangeInCell`)
- 지금: 텍스트 삽입/삭제 조합으로 우회한다. 문단 경계에서 인덱스가 밀리는 버그의 온상
- 규모: 작음. 안정성 개선 성격

### 우선순위 2 — 문서 완성도에 직결

#### ⑤ 표 셀 분할 (`splitTableCell` / `splitTableCellInto` / `splitTableCellsInRange`)  ✅ **구현됨 (F-6daa56b3)**
- 사용자: "이 칸 두 개로 나눠줘"
- 지금: **병합(`mergeTableCells`)은 되는데 분할이 안 된다.** 비대칭이 그대로 사용자에게 노출된다
- 규모: 작음. `table_edit.op`에 `split_cell` 추가

#### ⑥ 표 속성·셀 크기 (`setTableProperties` / `resizeTableCells` / `applyCellStyle`)
- 사용자: "열 너비 균등하게", "표 테두리 굵게", "표가 쪽 경계에서 잘려요"
- 지금: `setCellProperties`만 AI가 쓸 수 있다. `setTableProperties`는 **앱 내부 후처리에서만** 쓰인다(양식 변환 파이프라인)
- 규모: 작음~중간

#### ⑦ 표 수식 (`evaluateTableFormula`)  ✅ **구현됨 (F-8eb1f86f)**
- 사용자: **"합계 칸 계산해줘"**
- 지금: AI가 암산해서 숫자를 글자로 넣는다. 값이 바뀌어도 갱신 안 됨
- 규모: 작음. 회계·정산 문서에서 체감 큼

#### ⑧ 그림 조작 (`setPictureProperties` / `deletePictureControl` / `injectExternalImage`)
- 사용자: "그림 크기 맞춰줘", "이 그림 지워줘", "가운데 정렬"
- 지금: **삽입만 된다.** 넣은 뒤에는 손댈 수 없고, 문서에 어떤 그림이 있는지도 안 보인다
- 규모: 중간(인지+행위 둘 다 필요)

#### ⑨ 각주·미주 삽입/삭제 (`insertFootnote` / `deleteFootnote`)  ✅ **구현됨 (F-3e2d0f9a)**
- 지금: 기존 각주의 **텍스트 편집만** 된다(F-191fd6). 새로 달거나 지울 수 없다
- 규모: 작음

### 우선순위 3 — 문서 종류를 넓히는 것

#### ⑩ 페이지·구역 설정 (`setPageDef` / `setSectionDef` / `setColumnDef` / `insertColumnBreak`)
- 사용자: "가로로 돌려줘", "여백 좁게", "2단으로"
- 규모: 중간

#### ⑪ 도형·글상자 생성 (`createShapeControl` / `setShapeProperties` / `groupShapes` / `changeShapeZOrder`)
- 지금: **글상자 안 텍스트는 편집되는데(F-21a81b) 글상자를 새로 만들 수 없다**
- 규모: 중간~큼

#### ⑫ 수식 (`insertEquation` / `setEquationProperties` / `renderEquationPreview`)
- 이공계 논문·보고서. 규모: 중간

#### ⑬ 머리말/꼬리말 자동 필드 (`applyHfTemplate` / `insertFieldInHf`)
- 사용자: "쪽번호 넣어줘" → 지금은 고정 글자만 가능
- 규모: 작음

#### ⑭ 누름틀 완성 (`setFormValue` / `setFieldValueByName` / `updateClickHereProps`)
- `setFieldValue`만 노출. 이름으로 찾아 채우기 불가

#### ⑮ HTML 붙여넣기 (`pasteHtml` / `pasteHtmlInCell`)  ✅ **구현됨 (F-4f6d826e)**
- 웹/워드 내용을 **서식 유지**한 채 반입. 지금은 순수 텍스트로만
- 규모: 작음. 효과 큼

---

## 3. 워크플로 격차 (기능 아닌 구조)

| 격차 | 지금 | 필요 |
|---|---|---|
| **한 번에 여러 파일** | 열려 있는 문서 1개. 배치 엔진은 있으나 vitest 개발도구 (`src/tools/docx-batch-convert.batch.ts`) | 폴더 선택 UI + 진행률 + 파일별 리포트 + 실패 격리 |
| **반복 루프** | 요청 1회 → ActionScript 1회 → 승인. AI가 결과를 보고 다시 시도하지 않음 | 적용 후 재검증 루프(최소: 실패한 edit만 재시도) |
| **일괄 트랜잭션** | `beginBatch`/`endBatch`, `saveSnapshot`/`restoreSnapshot` 미노출 | 대량 편집 시 원자성·되돌리기 |
| **문서 비교** | 편집기에 `compare-dialog.ts` 있으나 AI 미연결 | "원본이랑 뭐가 달라졌어?" |

---

## 4. 기존 HOP 사용자 관점 — 어디부터?

오픈소스로 **기존 사용자가 바로 체감**할 순서. 기준은 (요청 빈도 × 구현 비용의 역수).

**1단계 — 배선만 하면 되는 것 (엔진 있음, payload 1종씩 추가) — ✅ 완료**

| # | 기능 | Feature | 상태 |
|---|---|---|---|
| 1 | 찾아 바꾸기 ① | `F-293e8c99` | ✅ done |
| 2 | 표 셀 분할 ⑤ | `F-6daa56b3` | ✅ done |
| 3 | 표 수식 ⑦ | `F-8eb1f86f` | ✅ done |
| 4 | 각주 삽입/삭제 ⑨ | `F-3e2d0f9a` | ✅ done |
| 5 | HTML 붙여넣기 ⑮ | `F-4f6d826e` | ✅ done |

각각 payload 타입 하나 + `ai-apply` 분기 하나 + 테스트로 끝났다(예상대로). 구현하며 나온
설계 결정은 각 shard의 `notes`에 남아 있다. 특히:

- **찾아 바꾸기**는 문단 ID가 아니라 문서 스코프 토큰 `target_id="doc"`을 쓴다. 화이트리스트
  검증을 통과해야 하므로 `serialize.rs`가 전체/윈도우 컨텍스트에만 이 토큰을 넣고,
  구간 스코프 요청(교정 패스)에는 넣지 않는다 — 구간 밖까지 바꾸는 건 스코프 위반이다.
- **표 수식**은 같은 표의 다른 편집보다 **나중에** 적용된다. 먼저 계산하면 낡은 값을
  합산한다("합계 행 추가하고 합계 계산해줘").
- **각주**는 `payload.type` 유무로 기존 F-191fd6 동작(내용만 수정)과 새 동작(각주 자체
  달기/떼기)을 가른다 — 하위 호환.
- **HTML 붙여넣기**는 문단이 몇 개 생길지 미리 알 수 없어 `getParagraphCount` 전후 차로
  잰다. 그 값이 뒤따르는 편집의 인덱스 보정에 쓰인다.

**2단계 — 컨텍스트를 넓혀야 하는 것 (serialize.rs 확장 선행)**
6. 스타일 목록 노출 → 스타일 적용/생성 ③
7. 서식 정보 노출 → "같은 서식으로" 류 요청
8. 그림 목록 노출 → 그림 조작 ⑧

인지 격차를 먼저 메워야 행위가 의미를 갖는다. **컨텍스트 크기 예산**을 함께 설계해야 한다 — 문단마다 서식을 다 실으면 토큰이 감당 안 된다. 요약 서식(문서 내 고유 서식 N종 + 문단→서식ID 매핑) 방식이 현실적이다.

**3단계 — 설계가 필요한 것**
9. 번호매기기 ② — 한글 번호 체계 매핑 설계
10. 페이지·구역 ⑩
11. 도형 생성 ⑪

**의도적으로 뒤로 미룰 것**
- 수식 ⑫ (사용자층 좁음)
- 완전 자율 에이전트 루프 (문서 편집은 예측 가능성이 자율성보다 중요)

---

## 5. 기여자를 위한 배선 지도

새 편집 종류 하나를 추가할 때 만져야 하는 곳 (찾아 바꾸기를 예로):

| 단계 | 파일 | 할 일 |
|---|---|---|
| 1 | `ai/schema.rs:393` | payload `type` enum에 `replace_text` 추가 + JSON 스키마 + 예시 |
| 2 | `core/ai-bridge.ts` | `EditPayload`에 필드 추가 (Rust serde와 snake_case 일치) |
| 3 | `core/ai-apply.ts` | 적용 분기 추가 → `wasm.replaceAll(...)` |
| 4 | `ai/serialize.rs` | (인지가 필요하면) 컨텍스트에 정보 추가 |
| 5 | 테스트 | `src/core/*.test.ts` — AC마다 1개 |
| 6 | spec | `clad create-feature` → 구현 후 `clad done` |

> ⚠️ **게이트 사각지대 — 반드시 알아야 할 것.**
> `clad check`의 Unit tests 스테이지는 언어가 `typescript`라 **`vitest`만 돌린다.**
> `cargo test`는 게이트에 없다. 실제로 F-293e8c99 구현 중 `serialize.rs`의 화이트리스트
> 크기 단언 5건을 깨뜨렸는데 게이트는 GREEN이었고, 나중에 손으로 `cargo test`를 돌려서야
> 발견했다. **Rust를 건드렸으면 `pnpm test:desktop`(= `cargo test`)을 직접 돌려라.**
> (`project.smoke` 프로브로 묶는 건 프로브당 5초 상한 때문에 컴파일 시간을 감당 못 한다 —
> CI 잡으로 거는 게 맞다.)

주의사항 (이미 값을 치른 것들):
- **새 hop 모듈은 `hop-overrides.ts`에 등록해야 한다.** 안 하면 upstream 버전이 로드된다
- **표를 건드리면 `hwp_table_check.py`가 exit 0 될 때까지 검증**
- `third_party/rhwp`는 read-only 서브모듈 — 패치 금지, 저장 후처리로 우회
- **표 구조는 LLM에 맡기지 않는다.** 실측으로 얻은 원칙 — compose 방식이 6×3 표를 6×2로 망가뜨렸다. 구조는 앱이 결정적으로, 내용만 AI가 (F-220afd, F-ae778890)

---

## 부록 — 실측 방법

```bash
# 엔진 메서드 목록
grep -oE "^    [a-zA-Z][a-zA-Z0-9_]*\(" apps/studio-host/vendor/rhwp-core/rhwp.d.ts \
  | tr -d ' (' | sort -u        # → 약 270개

# AI 파이프라인이 호출하는 것과 교차 대조
grep -oE "\b[a-zA-Z][a-zA-Z0-9_]*\(" apps/studio-host/src/core/ai-apply.ts \
  | tr -d '(' | sort -u

# 특정 기능이 앱 코드 어디서도 안 쓰이는지 확인
grep -rl "\breplaceAll\b" apps/studio-host/src apps/desktop/src-tauri/src   # → 0건
```

LLM 행위 어휘는 `ai/schema.rs:393` 한 줄에 전부 들어 있다. **거기 없는 건 AI가 할 수 없는 일이다.**
