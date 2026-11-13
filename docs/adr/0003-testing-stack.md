# 0003. Vitest for automated tests; E2E deferred

Date: 2026-11-13
Status: Accepted
Notion mapping: NFR-MAINT-006 (Automate critical tests)

## Context

NFR-MAINT-006 requires critical tests to be automated. The repository currently has no
test runner. Constraints: 30-day implementation window (16 Nov – 16 Dec), Node 22 +
pnpm 10, Next.js 16 + Turbopack, tests must stay hermetic by default (no network, no
database) so `pnpm verify` runs anywhere, including CI.

## Decision

- **Vitest** as the unit/integration runner (`vitest.config.ts`, `pnpm test`).
- Integration tests requiring PostgreSQL are colocated as `*.db.test.ts`, read
  `TEST_DATABASE_URL`, and are skipped when unset.
- Playwright E2E is **deferred**: introduce it when the interview room UI stabilises
  (M2), as its own decision, if the window allows.

## Alternatives considered

- Jest: slower TS/ESM setup with Next 16 + Turbopack conventions; Vitest shares the
  Vite/Turbopack-era config model.
- Immediate Playwright: risks consuming scarce days on browser automation before the
  core path exists.

## Consequences

- `pnpm verify` (lint + typecheck + test) is the always-on gate; already green.
- Hermetic default protects provider keys and user data; live provider verification
  stays with the feasibility matrix task (TT-16), documented as evidence.
- Follow-up: revisit E2E at M2 planning (TT-8 mock interview page).
