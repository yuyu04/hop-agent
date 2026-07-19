# HOP 0.4.0 Issue Triage 1-Pager

## Background

Recent GitHub reports cover HOP-owned print and Linux runtime behavior, document operations inherited from `rhwp`, and platform/package requests. HOP 0.4.0 also updates the upstream engine from the version used by most reports to `rhwp` 0.7.19.

## Problem

Closing reports based only on likely upstream fixes can hide regressions, while leaving reproducible HOP-owned bugs unresolved makes the 0.4.0 release less reliable. Several reports also lack the document or environment data required for a safe fix.

## Goal

- Fix small, clearly reproduced HOP-owned defects with focused regression coverage.
- Re-test document behavior against the 0.4.0 integration before adding HOP-specific workarounds.
- Investigate high-severity reports as far as repository fixtures and local platforms allow.
- Leave concise GitHub comments requesting only the missing evidence.
- Close an issue only when the 0.4.0 code and an appropriate regression or platform check demonstrate the fix.

## Non-goals

- Do not patch `third_party/rhwp` for HOP product behavior.
- Do not claim cross-platform resolution from a single-platform or synthetic check.
- Do not close issues merely because their original report used an older version.
- Do not add broad native diagnostics or packaging targets without evidence that they solve the reported problem.

## Constraints

- Keep the upstream boundary read-only.
- Preserve macOS, Windows, and Linux behavior.
- Treat document contents as private; do not log or upload user documents.
- Keep GitHub comments factual and distinguish confirmed results from hypotheses.
- Use `pnpm` for JavaScript dependencies and commands.

## Implementation outline

1. Apply the minimal print-height guard for issue #83 and cover the generated print CSS.
2. Re-test #70, #76, and #82 using repository or issue-provided fixtures on HOP 0.4.0.
3. Exercise save/reopen, direct-print preparation, and clipboard paths for #73, #78, and #75; fix only locally reproduced defects.
4. Record platform-specific checks that cannot be completed locally and request precise environment evidence for #72, #77, and #79.
5. Explain the actual scope of #80 and request measurable reproduction data for #81.
6. Run the full repository verification suite, then comment on and close only confirmed resolved issues.

## Verification plan

- Focused Studio and desktop unit tests while iterating.
- Repository fixture tests for document open, render, save, and reopen behavior where supported.
- `pnpm test`
- `pnpm run test:upstream`
- `pnpm run test:studio`
- `pnpm run test:desktop`
- `pnpm run clippy:desktop`
- `pnpm run build:studio`
- `pnpm --filter hop-desktop tauri build --debug --bundles app`

Platform-specific issues additionally require the affected OS/runtime or reporter confirmation before closure.

## Rollback or recovery notes

The print fix is isolated to generated print CSS and can be reverted without changing document data. If an upstream-dependent regression is found, keep the issue open and add the smallest adapter or upstream report possible; do not modify vendor source. GitHub issues closed prematurely can be reopened with the failed verification evidence attached.
