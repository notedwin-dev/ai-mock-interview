# AIMIS Code Review Instructions

Reviewers (human or agent) check changes along two axes: **correctness against the
approved requirements** and **repo standards**. AGENTS.md §3 governs conflicts — a
reviewer never silently resolves a requirement conflict; they escalate.

## When review is mandatory

- Every PR before merge (self-review at minimum for docs-only changes).
- **Owner review gates** (cannot be waived by agents): authentication, authorization,
  secrets, migrations, provider routing, privacy behaviour.
- Any change touching `src/lib/providers/`, `src/lib/auth/`, `src/lib/evaluation/`,
  Prisma schema/migrations, or env schema.

## Standards checklist

- [ ] `pnpm verify` green on the final commit (lint + typecheck + tests).
- [ ] Follows [CONVENTIONS.md](./CONVENTIONS.md) (naming, file placement, commit format).
- [ ] No `any`, no silent catches, typed errors at boundaries, zod at every input.
- [ ] Tests added for new business rules; integration tests for DB behaviour;
      time-dependent logic uses an injected clock (TESTING.md).
- [ ] No dead code, no unused deps, no mock left pretending to be production.

## Correctness checklist (AIMIS-specific)

- [ ] Authorization and ownership enforced at the **server boundary** for every new
      resource (NFR-SEC-002); recruiter surfaces expose only the public allowlist
      (NFR-SEC-008, FR-PROFILE-003).
- [ ] No secret, transcript content, or provider payload can reach logs, error
      responses, or the client bundle (NFR-SEC-005, NFR-PRIV-006).
- [ ] Provider credentials: write-only, encrypted at rest (ADR-0005), exact
      `model_id` preserved, no silent substitution or provider fallback, fail-closed
      validation (FR-PROVIDER-004/006/008).
- [ ] Idempotency considered: repeated submits, `end_call`, job creation, transcript
      writes (FR-ASYNC-007, NFR-REL-002/004).
- [ ] Assessment-unit semantics respected (evaluate units, not messages;
      FR-TRANSCRIPT-004/005) and one evaluation per session (unique constraint).
- [ ] Lifecycle rules respected: meeting-owner deletion cascades; 7-day grace
      semantics; no backup/log policy values invented (ADR-023/024, POL-01/02).
- [ ] Camera/recording media never becomes AI input (ADR-005, NFR-PRIV-003);
      camera preview stays local.
- [ ] Migrations derive from dictionary v0.4; no hand-edited migration files;
      destructive changes flagged.
- [ ] Next.js 16 conventions verified against `node_modules/next/dist/docs/`
      (`proxy.ts`, cacheComponents) — not from memory.
- [ ] Requirement UIDs referenced in the PR; statuses updated in Notion only where
      acceptance evidence exists.

## Review output

Findings grouped as: **Blocking** (must fix), **Should fix**, **Notes**. For
owner-gated areas, state explicitly what the owner must confirm. A review never
approves its own migration/auth/secrets change on behalf of the owner.

## Reviewing with sub-agents

The `.opencode/agent/aimis-reviewer.md` agent performs the standards + correctness
checklists and returns findings; it must not merge, push, or update Notion statuses.
