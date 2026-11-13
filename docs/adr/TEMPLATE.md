# ADR template

Copy this directory file as `docs/adr/NNNN-kebab-title.md` (next free number).

```markdown
# NNNN. <Title>

Date: YYYY-MM-DD
Status: Proposed | Accepted | Superseded by NNNN
Notion mapping: <ADR-xxx / OWNER-xxx / OPEN-xxx ID if one exists, or "no Notion record yet">

## Context

What problem forces a decision? Cite requirement UIDs (FR/NFR/TT) and constraints.

## Decision

One or two sentences. Present tense, active voice.

## Alternatives considered

- <alt>: why not.

## Consequences

- Positive…
- Negative / accepted trade-offs…
- Follow-ups (TT-xxx, docs to update).
```

Rules:

- Repo ADR numbering (`0001…`) is **independent** of Notion's decision register
  (`ADR-001…030`). Cross-reference Notion IDs instead of renumbering.
- Repo ADRs capture *engineering* detail (library, mechanism). Requirement-level
  decisions stay in Notion; owner approval is recorded there first.
- An ADR never marks a Notion item Approved — only the owner does that.
- Superseding an ADR: flip the old one's Status and link both ways.
