## cladding

This project is managed by **cladding** (Spec-Anchored Agent Harness).

**Spec is SSoT** — `spec.yaml` is authoritative. Any code change must
satisfy the relevant `features[]` and `acceptance_criteria`. Run
`clad check --strict` before commit.

**Persona separation** — librarian writes spec, reviewer audits,
specialists implement. The agent that authors must not sign off on its
own work (anti-self-cert invariant).

**Feature cycle — one at a time** — Work ONE feature end-to-end before
the next: author its shard with `acceptance_criteria` (+ `modules`) →
implement → author tests (separate context) → mark it done with
`clad done <featureId>` (it flips `status: done` ONLY if
`clad check --tier=pre-push --strict` is GREEN, reverting otherwise) →
only then the next. Do NOT author shards ahead of the code that implements
them, and do NOT hand-write `status: done`. Independent features (no
shared `modules`) may run as parallel instances of this same cycle.
Enforced by the `PLANNED_BACKLOG` detector; see `docs/feature-cycle.md`.

**Hash-based IDs** — Never hand-author `F-NNN` filenames; use the
`clad` CLI or invoke cladding through the `/cladding:init` slash
command. The multi-developer-safe model is in
`docs/spec-ids-multi-dev.md`.

**Drift detectors** — `clad check --strict` runs every drift detector.
Don't suppress findings; either fix them or update spec.
