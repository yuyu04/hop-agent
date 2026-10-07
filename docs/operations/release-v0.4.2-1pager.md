# HOP v0.4.2 Release 1-Pager

## Background

HOP v0.4.1 is the latest published desktop release. The current release candidate updates the read-only rhwp integration to v0.8.4, removes HOP-owned PDF assembly that duplicated upstream behavior, enables searchable PDF text maps, and exposes rhwp's system, light, and dark themes through the HOP studio host.

## Problem

The verified upstream integration and HOP fixes cannot be delivered from the immutable `v0.4.1` tag. They require a new patch release with aligned application metadata, signed updater artifacts, and the existing stable asset names.

## Goal

- Release the verified changes as HOP v0.4.2.
- Build every supported platform from the immutable `v0.4.2` tag.
- Inspect downloaded release artifacts before publishing to the stable update channel.
- Verify the published macOS installer and installed UI behavior.

## Non-goals

- Do not move or recreate an existing release tag.
- Do not change signing, updater, or packaging behavior for this patch release.
- Do not publish locally built debug artifacts.

## Constraints

- Keep all HOP version sources aligned at `0.4.2`.
- Keep `third_party/rhwp` read-only and pinned to the verified v0.8.4 commit.
- Preserve stable macOS, Windows, and Linux asset names.
- Publish only GitHub Actions artifacts built from `v0.4.2`.
- Require macOS signing and notarization and signed updater metadata.

## Implementation outline

1. Align workspace, desktop, Tauri, Cargo, and Quick Look versions at `0.4.2`.
2. Run the full test suite, clippy, upstream verification, and a local debug app bundle build.
3. Commit and push the release source to the integration branch and `main`.
4. Create and push `v0.4.2`, then dispatch every supported platform with a draft release.
5. Download and verify checksums, updater entries, signatures, notarization, asset names, and the macOS installer.
6. Publish only after the downloaded draft passes installation and theme smoke tests, then re-download the public latest asset and repeat the smoke check.

## Verification plan

- `pnpm test`
- `pnpm run clippy:desktop`
- `pnpm upstream:verify`
- `pnpm --filter hop-desktop tauri build --debug --bundles app`
- GitHub Actions release matrix for macOS arm64/x64, Windows x64, Linux x64, and Linux arm64
- Draft asset, checksum, updater manifest, signing, notarization, and install smoke checks
- Computer Use verification of the downloaded macOS build, including dark-theme selection and persistence

## Rollback or recovery notes

If a local gate fails, fix forward before tagging. If GitHub Actions fails after `v0.4.2` is pushed, keep the release draft unpublished and fix forward without moving the tag; request explicit approval before any tag rewrite. If downloaded artifacts fail validation, leave the release as a draft and do not expose it through the stable latest channel.
