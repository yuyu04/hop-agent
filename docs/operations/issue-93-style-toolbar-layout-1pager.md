# Issue #93: Style Toolbar Layout

## Background

HOP imports the `rhwp-studio` toolbar and responsive styles from the pinned
`third_party/rhwp` submodule, while retaining a HOP-owned `index.html` for the
desktop-specific file menu and native commands.

## Problem

The rhwp v0.8.4 style toolbar CSS expects ribbon-group markup introduced
upstream. HOP's HTML still uses the older flat toolbar markup, so flex wrapping
places the font-size and color controls on a second visual row even on a wide
macOS window.

## Goal

Restore the upstream v0.8.4 style toolbar layout in HOP and make future markup
drift fail repository verification instead of reaching a release.

## Non-goals

- Changing toolbar behavior or command ownership.
- Editing the read-only rhwp submodule.
- Redesigning other upstream chrome or adopting unrelated upstream features.

## Constraints

- Preserve every existing control ID consumed by the upstream `Toolbar` class.
- Preserve HOP-owned menus, native save/export/print behavior, and theme choices.
- Keep the fix cross-platform and avoid macOS-only CSS.

## Implementation outline

1. Replace only HOP's `#style-bar` subtree with the matching rhwp v0.8.4
   subtree.
2. Add a repository boundary test that compares the marked style-bar section
   with the pinned upstream HTML, allowing the surrounding HOP shell to remain
   independently owned.

## Verification plan

- Run the focused upstream-boundary and studio tests.
- Build the studio host.
- Build and launch the macOS debug app, then inspect the toolbar at a wide
  window size in light and dark themes.

## Rollback or recovery

Revert the HOP HTML subtree and its contract test. No document or native data
format changes are involved.
