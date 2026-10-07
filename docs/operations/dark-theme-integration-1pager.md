# 다크 테마 통합 1-Pager

## Background

rhwp v0.8.4는 system/light/dark 설정, 저장, OS theme 변경 감지, menu command와 CSS token을 제공한다.
HOP은 upstream `viewCommands`와 base styles를 사용하지만 theme lifecycle과 메뉴 markup을 host bootstrap에
연결하지 않아 사용자가 다크 테마를 선택할 수 없다.

## Problem

- Windows를 포함한 desktop에서 시스템 다크 테마가 초기화되지 않는다.
- upstream theme command가 등록되어도 HOP 메뉴에서 접근할 수 없다.
- 일부 HOP 전용 화면이 고정된 밝은 색을 사용해 theme token을 우회한다.

## Goal

- 시스템 설정을 기본으로 따르고 light/dark를 명시적으로 선택할 수 있게 한다.
- theme 상태와 persistence는 upstream 단일 protocol을 사용한다.
- HOP 전용 home, update, custom select와 font dialog도 같은 token을 사용한다.

## Non-goals

- 문서 종이 자체를 어둡게 바꾸지 않는다.
- OS별 별도 theme 구현이나 native preference 저장소를 만들지 않는다.
- upstream theme module을 복사하거나 수정하지 않는다.

## Constraints

- macOS, Windows와 Linux에서 같은 DOM/CSS contract를 사용한다.
- HOP bootstrap은 theme lifecycle을 한 번만 설치한다.
- 메뉴의 radio 상태와 저장된 설정, OS theme 변경이 일치해야 한다.
- `third_party/rhwp`는 읽기 전용이다.

## Implementation outline

1. HOP upstream adapter가 rhwp theme API를 다시 export한다.
2. bootstrap이 `initThemeSync`를 한 번 호출하고 theme/command 변경 event를 발행한다.
3. 보기 메뉴에 upstream과 동일한 system/light/dark command markup을 추가한다.
4. HOP 전용 CSS의 의미 있는 색을 기존 upstream theme token으로 치환한다.

## Verification plan

- theme 초기화, 저장된 mode와 OS media query 변경을 단위 테스트한다.
- production build 후 실제 HOP 앱에서 세 메뉴 선택과 화면 대비를 확인한다.
- Studio 전체 테스트와 build를 실행한다.

## Rollback and recovery

bootstrap 호출과 메뉴 항목을 제거하면 종전 light-only 동작으로 돌아간다. 저장된 upstream theme preference는
무해하며 다음 초기화 때 다시 사용된다.
