# 0001. Record engineering decisions as repo-local ADRs

Date: 2026-11-13
Status: Accepted
Notion mapping: complements "Architecture Decisions & Open Questions"
(`4121f0a3fda781ba8f36c2f55c065b4e`)

## Context

Notion holds the authoritative decision register (ADR-001…030, OWNER-001…008) but it is
deliberately requirement-level. Engineering detail (which library, which mechanism) does
not belong there, yet agents and future contributors need durable, greppable rationale
next to the code. Two risks: duplicating Notion pages (forbidden), and decisions living
only in chat history.

## Decision

Maintain repo-local ADRs in `docs/adr/` with independent numbering, each
cross-referencing the Notion decision it implements. The template lives in
`docs/adr/TEMPLATE.md`. Repo ADRs never alter approved requirements and never mark
Notion items approved.

## Consequences

- Decisions are greppable from the codebase without Notion access.
- Deliberate non-duplication: two registers with distinct scopes and explicit links.
- Follow-up: when the owner records a Notion decision that supersedes a repo ADR, the
  repo ADR is marked superseded in the same change.
