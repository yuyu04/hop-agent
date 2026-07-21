# Issue #85 Table Input Rendering 1-Pager

## Background

HOP uses the upstream `rhwp` input handler but keeps a HOP-owned `CanvasView` fork for desktop page positioning and renderer recovery. Upstream `rhwp` now emits a page-local invalidation event for stable table-cell text edits so it can redraw only the affected page.

## Problem

The HOP `CanvasView` does not consume `document-page-invalidated`. Table-cell edits update the document model and caret, but the page canvas remains stale until the deferred pagination idle flush emits a full `document-changed` event roughly ten seconds later.

## Goal

Render table-cell text changes on the next animation frame by consuming the upstream page-local invalidation event in HOP.

## Non-goals

- Do not change upstream `third_party/rhwp` source.
- Do not change document mutation, pagination, save, or IME behavior.
- Do not replace the HOP page renderer or port unrelated upstream `CanvasView` features.

## Constraints

- Preserve HOP page positioning and overlay cleanup behavior.
- Coalesce repeated input invalidations into one animation-frame refresh.
- Fall back to a full refresh if the event payload or page count is inconsistent.
- Keep behavior platform-neutral for macOS, Windows, and Linux.
- `CanvasView` exceeds the suggested 300-line limit after this change. The invalidation queue remains local because it must share the canvas pool and page-release lifecycle; extracting it would add a stateful adapter for one tightly coupled event path.

## Implementation outline

- Subscribe the HOP `CanvasView` to `document-page-invalidated`.
- Validate and queue affected page indices, then redraw active pages once per animation frame.
- Cancel queued redraws when pages are released, the document is reset, or a full refresh supersedes them.
- Add a regression test proving repeated page invalidations coalesce and redraw the existing page.

## Verification plan

- Run the focused `CanvasView` and `HopPageRenderer` tests.
- Run `pnpm run test:upstream` and `pnpm run test:studio`.
- Build the studio host.
- Smoke-test table input and confirm the canvas changes immediately rather than on the ten-second idle flush.

## Rollback or recovery notes

The change is isolated to HOP's view adapter and its test. If page-local redraw causes an overlay or positioning regression, remove the event subscription and queued refresh implementation; document data and upstream behavior are unaffected.
