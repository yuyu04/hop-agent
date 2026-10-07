# HOP v0.4.3 Release 1-Pager

## Background

The immutable `v0.4.2` tag passed local macOS verification but its GitHub Actions unit-test gate exposed that searchable PDF output depended on an installed Korean system font. The workflow stopped before any platform build or GitHub Release was created.

## Problem

HOP's web font assets are WOFF2 files, while the native PDF font database needs a supported file-backed font to retain text and emit ToUnicode mappings on a clean Linux or Windows installation. Relying on OS fonts makes PDF searchability environment-dependent.

## Goal

- Package one licensed Noto Sans KR TTF resource for native PDF fallback.
- Resolve the packaged font through Tauri's cross-platform resource API.
- Release the complete verified change set as HOP v0.4.3.
- Download and test the draft and published macOS artifacts before completion.

## Non-goals

- Do not move or recreate the existing `v0.4.2` tag.
- Do not fork or modify `third_party/rhwp`.
- Do not add another PDF implementation or temporary font extraction path.
- Do not publish locally built artifacts.

## Constraints

- Keep all HOP version sources aligned at `0.4.3`.
- Preserve stable release asset names and updater protocol.
- Ship the upstream font license beside the packaged TTF.
- Keep local user-font discovery separate from the application-owned PDF fallback.

## Implementation outline

1. Bundle `NotoSansKR-Regular.ttf` and its OFL license as Tauri resources.
2. Resolve the bundled PDF font directory at the command boundary and pass it into the thin rhwp adapter.
3. Set deterministic Noto Sans KR generic fallbacks in the adapter while leaving PDF assembly and encoding upstream.
4. Run the full local and Linux CI gates, then build every supported platform from `v0.4.3` as a draft release.
5. Verify downloaded assets, signatures, notarization, checksums, updater metadata, installation, and theme behavior before publishing.

## Verification plan

- `pnpm test`
- `pnpm run clippy:desktop`
- `pnpm upstream:verify`
- `pnpm --filter hop-desktop tauri build --debug --bundles app`
- Linux GitHub Actions unit-test gate proving `/ToUnicode` without system Korean fonts
- Full GitHub Actions platform matrix and release integrity checks
- Computer Use smoke test against a freshly downloaded macOS installer

## Rollback or recovery notes

If any gate fails, leave v0.4.3 unpublished and fix forward under a new immutable patch tag. Never move v0.4.2 or v0.4.3 after pushing them. If packaging the font disrupts signing or installation, remove the resource mapping and keep the release draft unpublished while designing a compatible resource path.
