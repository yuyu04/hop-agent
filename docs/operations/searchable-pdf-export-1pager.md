# 검색 가능한 PDF 내보내기 1-Pager

## Background

HOP은 문서를 SVG로 렌더링한 뒤 desktop crate가 `svg2pdf`와 `pdf-writer`를 직접 조합해 PDF를 만든다.
이 경로는 글꼴 fallback을 HOP 정책에 맞게 정리하지만 `embed_text: false`를 고정해 모든 글자를 path로
변환한다. 따라서 PDF에서 텍스트 검색과 선택이 불가능하다.

rhwp v0.8.4는 다중 페이지 SVG를 검색 가능한 PDF로 변환하고 `ToUnicode`를 보정하는 native API를
제공한다. HOP이 같은 PDF 조립 protocol을 복제할 이유가 없다.

## Problem

- PDF 내보내기가 텍스트를 보존하지 않는다.
- HOP과 rhwp가 각각 페이지 조립, object reference 재번호화와 PDF metadata를 구현한다.
- 중복 구현 때문에 upstream의 PDF 접근성·호환성 개선이 HOP에 자동 반영되지 않는다.

## Goal

- 내보낸 PDF에서 텍스트 검색과 선택이 가능하게 한다.
- HOP은 restricted font fallback과 파일 저장/progress만 소유한다.
- PDF encoding, font embedding과 다중 페이지 조립은 rhwp에 위임한다.

## Non-goals

- 다른 PDF backend나 내보내기 기능을 함께 변경하지 않는다.
- direct Skia PDF backend를 새로 채택하지 않는다.
- PDF 내보내기 UI와 페이지 범위 protocol을 변경하지 않는다.

## Constraints

- macOS, Windows와 Linux에서 같은 경로를 사용한다.
- restricted font를 PDF에 새로 포함하지 않는다.
- native 파일 쓰기는 원자적이어야 하고 기존 progress event를 보존한다.
- `third_party/rhwp`는 수정하지 않는다.

## Implementation outline

1. desktop은 기존처럼 페이지 SVG를 렌더링하고 restricted font fallback을 적용한다.
2. `rhwp-adapter`의 작은 semantic API가 정리된 SVG 목록을 rhwp v0.8.4 PDF API로 전달한다.
3. adapter는 텍스트 임베딩을 항상 활성화하고 HOP이 발견한 추가 font directory만 옵션으로 넘긴다.
4. desktop의 `svg2pdf`/`pdf-writer` 조립 코드와 직접 의존성을 제거한다.

## Verification plan

- 옵션 회귀 테스트로 searchable PDF protocol이 `embed_text=true`인지 확인한다.
- 샘플 HWP/HWPX를 내보내 `pdftotext` 또는 동등한 parser로 텍스트가 추출되는지 확인한다.
- desktop/Quick Look 테스트, clippy, upstream contract와 debug build를 실행한다.

## Rollback and recovery

adapter 호출을 제거하고 이전 desktop 변환 경로를 복원하면 된다. 파일 쓰기와 command protocol은
변경하지 않으므로 저장된 문서나 사용자 설정 migration은 없다.
