# HOP v0.4.4 Release 1-Pager

## Background

HOP v0.4.3 imports the rhwp v0.8.4 style-toolbar CSS while retaining a HOP-owned
studio HTML shell. Issue #93 showed that the shell still used the previous flat
toolbar markup, causing controls to wrap into a broken second row on macOS.

## Problem

The immutable v0.4.3 release cannot receive the corrected upstream DOM contract.
The fix needs a new patch release with aligned desktop and Quick Look metadata,
signed updater artifacts, and stable cross-platform asset names. The first draft
build also exposed a `pipefail` false negative in the release artifact presence
check: `grep -q` closed its pipe early and caused `find` to fail with SIGPIPE.

## Goal

- Release the rhwp v0.8.4 style-toolbar markup compatibility fix as HOP v0.4.4.
- Detect future style-toolbar CSS/DOM drift during repository verification.
- Build and publish the existing macOS, Windows, and Linux release matrix.

## Non-goals

- Do not edit the read-only rhwp submodule.
- Do not add macOS-specific layout CSS or redesign the toolbar.
- Do not change signing, updater, packaging, or asset naming behavior.

## Constraints

- Keep all HOP version sources aligned at `0.4.4`.
- Preserve all upstream toolbar control IDs and HOP-owned native commands.
- Keep release tags immutable and publish only artifacts built by GitHub Actions.

## Implementation outline

1. Synchronize only HOP's `#style-bar` subtree with pinned rhwp v0.8.4.
2. Add a boundary test that compares the HOP and pinned upstream toolbar markup.
3. Align application metadata at v0.4.4 and run the full local release gates.
4. Make the release artifact presence check independent of short-circuit pipes.
5. Tag the verified commit, build every supported platform as a draft release,
   inspect the release assets and updater manifest, then publish it.

## Verification plan

- `pnpm test`
- `pnpm run clippy:desktop`
- `pnpm upstream:verify`
- `pnpm run build:studio`
- pipefail-safe release workflow regression test
- macOS debug application visual inspection
- GitHub Actions platform matrix and release integrity checks
- Published asset names, checksums, and updater manifest inspection

## Rollback or recovery notes

If a local gate fails, fix forward before tagging. If GitHub Actions fails after
`v0.4.4` is pushed, leave the draft unpublished and fix forward without moving
the tag. Never rewrite or recreate the existing v0.4.3 or v0.4.4 tags.
