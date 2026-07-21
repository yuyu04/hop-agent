# HOP v0.4.1 Release 1-Pager

## Background

HOP v0.4.0 is already published. Subsequent HOP-owned fixes restore immediate table-cell text rendering, preserve upstream static-layer reuse, and harden macOS quit handling and release checksum generation.

## Problem

These fixes cannot be shipped from the immutable `v0.4.0` tag. They need a new patch release with aligned application metadata, signed updater artifacts, and stable cross-platform asset names.

## Goal

- Release the verified fixes as HOP v0.4.1.
- Build every supported platform from the immutable `v0.4.1` tag.
- Inspect a draft release before publishing it to the stable update channel.

## Non-goals

- Do not move or recreate `v0.4.0`.
- Do not change `rhwp`, signing, updater, or packaging behavior for this patch release.
- Do not publish locally built debug artifacts.

## Constraints

- Keep all HOP version sources aligned at `0.4.1`.
- Preserve stable macOS, Windows, and Linux asset names.
- Publish only GitHub Actions artifacts built from `v0.4.1`.
- Require macOS signing and notarization and signed updater metadata.

## Implementation outline

1. Align workspace, desktop, Tauri, Cargo, and Quick Look versions at `0.4.1`.
2. Run the full test suite, clippy, upstream verification, and a local debug app bundle build.
3. Commit the version bump and release plan.
4. Push `main`, create and push `v0.4.1`, then dispatch all supported platforms with a draft release.
5. Verify checksums, updater entries, signatures, notarization, asset names, and table-input behavior before publishing.

## Verification plan

- `pnpm test`
- `pnpm run clippy:desktop`
- `pnpm upstream:verify`
- `pnpm --filter hop-desktop tauri build --debug --bundles app`
- GitHub Actions release matrix for macOS arm64/x64, Windows x64, Linux x64, and Linux arm64
- Draft asset, checksum, updater manifest, signing, notarization, and install smoke checks

## Rollback or recovery notes

If a local gate fails, fix forward before tagging. If GitHub Actions fails after `v0.4.1` is pushed, keep the release draft unpublished and fix forward without moving the tag; request explicit approval before any tag rewrite.
