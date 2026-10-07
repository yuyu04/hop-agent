# rhwp v0.8.4 통합과 upstream 경계 정리 1-Pager

## Background

HOP v0.4.1은 `rhwp` v0.7.19를 읽기 전용 submodule과 생성된 WASM으로 사용한다. 최신 안정
릴리스 v0.8.4는 저장 왕복 보존, 암호 문서, 중첩 표, 렌더링과 편집 프로토콜을 크게 확장했다.
HOP은 upstream studio의 일부를 fork 또는 extension으로 shadowing하므로 버전만 올리면 upstream이
이미 해결한 동작을 중복 구현하거나 새 프로토콜을 우회할 수 있다.

## Problem

현재 경계에는 HOP 제품 정책뿐 아니라 과거 upstream 결함을 보완하기 위해 만든 override도 섞여 있다.
이 둘을 구분하지 않으면 업데이트 때마다 큰 파일을 수동 병합하고, HOP과 rhwp가 서로 다른 저장,
렌더링, 편집 이벤트 계약을 갖게 된다.

## Goal

- rhwp를 불변 안정 태그 v0.8.4로 갱신한다.
- HOP과 rhwp 사이의 파일, 편집, 렌더링, 글꼴, dialog 프로토콜을 명시한다.
- upstream에서 해결된 workaround와 fork를 제거하거나 얇은 extension으로 축소한다.
- 각 경계는 한 가지 일을 하고 텍스트/JSON/명시적 함수 계약으로 조합되게 한다.
- 다음 업데이트가 hash 변화와 집중 테스트로 검토 가능하게 만든다.

## Non-goals

- `third_party/rhwp`를 HOP 제품 기능 때문에 수정하지 않는다.
- 신규 upstream 기능을 HOP UI에 자동으로 노출하지 않는다.
- 이번 작업에서 HOP 버전, 배포 채널이나 릴리스 workflow를 변경하지 않는다.
- 근거 없이 모든 override를 한 번에 다시 작성하지 않는다.

## Constraints

- pnpm만 사용하고 Node 24, upstream이 고정한 Rust와 wasm-pack 버전을 따른다.
- macOS, Windows, Linux의 파일과 경로 동작을 보존한다.
- native 파일/session/save/export/print는 Rust와 typed bridge가 소유한다.
- side effect는 Tauri bridge와 native boundary에 두고 studio adapter는 변환과 조합만 담당한다.
- submodule, 생성 WASM, 두 Cargo manifest/lockfile과 override baseline은 같은 release를 가리켜야 한다.

## Implementation outline

1. updater로 submodule, WASM, provenance, Cargo manifest/lockfile과 counterpart baseline을 v0.8.4에 맞춘다.
2. 변경된 upstream counterpart를 HOP override와 대조해 제품 정책과 workaround를 분류한다.
3. upstream hook/API가 생긴 workaround는 삭제하고, 필요한 제품 차이는 작은 adapter로 남긴다.
4. override manifest에 남은 fork/extension의 이유와 검증 책임을 구체적으로 기록한다.
5. 프로토콜 검증을 정적 baseline과 집중 단위 테스트로 고정한다.

## Decisions and result

- v0.8.4가 page positioning, overlay retry/invalidation, renderer revision/fallback과 ruler 계산을 소유하므로
  HOP의 `view/*` fork를 제거하고 upstream `CanvasView`/`RendererSession`/`Ruler`를 조합한다.
- v0.8.4의 style command가 snapshot undo와 font ID resolution을 제공하므로 HOP format/style-edit fork를
  제거한다. 제한 글꼴 authoring 정책은 font catalog와 명시적인 UI 선택 경계에 두고, 기존 document
  font lookup과 모양 복사는 원본 ID를 보존한다.
- upstream이 겹치는 text를 만들 수 있는 validation auto-reflow를 호출하지 않으므로 HOP의 자동 repair
  modal/path도 제거하고 upstream validation 정책을 따른다.
- updater가 CLI의 pnpm `--` separator와 upstream Cargo patch source 변경을 명시적으로 처리한다. 두 Cargo
  manifest, lockfile, submodule, WASM과 provenance를 하나의 rollback 단위로 관리한다. PDF 결정성을 위한
  patch는 HOP 정책으로 유지하되 upstream이 같은 patch의 source를 바꾸면 두 graph를 함께 전환한다.
- native 파일/session/save/export/print, WebView clipboard, desktop shortcut, 비동기 로컬 글꼴과 dialog focus는
  HOP 제품 정책이므로 얇은 extension 또는 contribution으로 유지한다.
- upstream의 browser 전용 format-save와 print-to-PDF command는 native session을 우회하므로 command group에서
  제외한다. native의 일반 Save As와 PDF export가 형식 선택과 side effect를 단일 경계에서 소유한다.
- merge-undo 전용 paragraph metadata는 desktop command payload로 노출하지 않고 `rhwp-adapter`가 일반 편집용
  split protocol로 축소한다. shortcut fork는 upstream의 physical key와 platform 조건을 그대로 보존한다.

## Verification plan

- `pnpm upstream:verify`, `pnpm run test:upstream`
- studio/desktop/Quick Look 테스트와 desktop clippy
- studio build와 debug app bundle
- HWP/HWPX 열기, 편집, 저장, 재열기, drag/drop, 다중 창, 외부 변경 충돌
- 로컬 글꼴, PDF export, 인쇄, Quick Look smoke test
- macOS, Windows, Linux CI

## Rollback and recovery

업데이트 도구의 자동 복구를 우선 사용하고 실패 상태를 보존한다. `git reset --hard`, submodule 직접
수정이나 생성물 수동 덮어쓰기는 사용하지 않는다. v0.8.4 고유 회귀가 의심되면 v0.8.2를 진단용
checkpoint로 사용해 v0.8.0 계열과 v0.8.3 이후 변경을 분리한다.
