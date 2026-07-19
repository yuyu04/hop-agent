# HOP v0.4.0 Release 1-Pager

## Background

HOP v0.3.1 is the latest published desktop release. The 0.4.0 candidate updates the document engine to `rhwp` v0.7.19, isolates the upstream integration behind explicit adapters and compatibility baselines, and fixes HOP-owned print pagination and clipboard regressions.

## Problem

The 0.4.0 source must be verified as a complete desktop application and released from an immutable tag with signed updater metadata and stable cross-platform asset names.

## Goal

- Verify repository tests, Studio production build, Rust checks, and a macOS debug app bundle.
- Smoke-test the packaged app's document, menu, editing, clipboard, save, and print entry flows.
- Tag the verified source as `v0.4.0`.
- Build all supported release platforms through the `HOP Desktop Release` workflow.
- Inspect the draft release assets and updater manifest before publishing the stable release.

## Non-goals

- Do not patch `third_party/rhwp` for unresolved upstream renderer issues.
- Do not change signing, updater, packaging, or workflow behavior during the release unless a release gate exposes a defect.
- Do not move or recreate a pushed release tag.

## Constraints

- Use `pnpm` for JavaScript commands and dependency installation.
- Keep `v0.4.0` aligned with every HOP version source.
- Preserve stable macOS, Windows, and Linux release asset names.
- Build every platform with the Rust toolchain pinned by the `rhwp` upstream contract.
- Publish only artifacts produced by GitHub Actions from the pushed tag.

## Implementation outline

1. Run local repository, Studio, desktop, Quick Look, clippy, upstream contract, and debug bundle checks.
2. Smoke-test the packaged macOS app with a temporary document and representative issue fixtures.
3. Commit this release plan and any final release-only corrections.
4. Push `main`, create and push `v0.4.0`, then dispatch all supported platforms with tests enabled and a draft release.
5. Verify workflow completion, checksums, updater platform entries, expected assets, and release notes.
6. Publish the verified non-prerelease release.

## Release notes

`rhwp` 0.7.19 통합과 향후 upstream 업데이트 안정성, 데스크톱 편집 회귀 수정을 중심으로 한 릴리즈입니다.

### 변경 사항

- 문서 엔진을 `rhwp` 0.7.19로 업데이트했습니다.
- HOP 확장과 upstream 코드를 명확한 adapter/override 경계로 분리하고 업데이트 검증 도구와 운영 매뉴얼을 추가했습니다.
- 파일·편집 메뉴가 클릭되지 않던 명령 연결 회귀를 수정했습니다.
- 일반 텍스트와 표 셀의 시스템 복사·잘라내기 동작을 복구하고 실패 시 원문을 보호합니다.
- 직접 인쇄 시 마지막에 빈 페이지가 추가될 수 있는 문제를 수정하고 다중 페이지 회귀 테스트를 보강했습니다.
- 로컬 글꼴 탐색과 HOP 전용 글꼴 정책을 upstream 변경과 독립적으로 유지하도록 정리했습니다.

**Full Changelog**: https://github.com/golbin/hop/compare/v0.3.1...v0.4.0

## Verification plan

- `pnpm upstream:verify`
- `pnpm test`
- `pnpm run clippy:desktop`
- `pnpm run build:studio`
- `pnpm --filter hop-desktop tauri build --debug --bundles app`
- Windows/Linux conditional-compilation and release-matrix review
- Packaged macOS smoke test
- GitHub Actions `HOP Desktop Release` for every supported platform
- Draft asset names, updater signatures, `latest.json`, and `SHA256SUMS.txt`

## Rollback or recovery notes

If a local gate fails, fix forward and rerun all affected checks before tagging. If GitHub Actions fails after the tag is pushed, keep the release draft and fix forward without moving the tag; request explicit approval before any history or tag rewrite. Publish only after the intended tag, artifacts, checksums, and updater manifest agree.
