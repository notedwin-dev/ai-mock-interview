# AIMIS Testing Strategy

Status: `[repo-decision]` stack — ADR-0003. Requirement driver: NFR-MAINT-006
(automate critical tests) and the approved rule that a requirement is not "verified"
without test evidence.

## Levels

| Level | Tool | Scope |
| --- | --- | --- |
| Unit | Vitest | Business rules with injected fakes: rubric weighting, idempotency, assessment-unit grouping, consent checks, error classification, crypto round-trip, SSRF guard decisions |
| Integration | Vitest + PostgreSQL (Docker or `pnpm db:local`) | Migrations/constraints, transactional flows, worker claiming (`FOR UPDATE SKIP LOCKED`), cascade deletions, unique-constraint idempotency |
| Component/UI | Deferred until the interview room UI exists | Only after a UI framework decision is proven in the vertical slice |
| E2E | Deferred (Playwright, when justified) | The 30-day window prioritises a tested core over browser automation breadth |
| Manual | Scripted checks | Voice loop, mic permissions, camera local-only, browser matrix (NFR-COMP-001/002) |

Manual verification of voice UX is expected in the foundation milestones — it is
reported as manual evidence, never claimed as automated coverage.

## Test placement and rules

- Colocated: `src/**/<module>.test.ts`. Integration tests that need PostgreSQL live in
  `src/**/*.db.test.ts` and are **skipped** when `TEST_DATABASE_URL` is unset, so the
  default `pnpm test` stays hermetic and fast (no network, no DB).
- Service-level integration tests: services read the database through `@/lib/db`
  (`DATABASE_URL`). When the `TEST_DATABASE_URL` gate is set, `vitest.setup.mts`
  points `DATABASE_URL` at the test database inside the test process (before module
  import), so service tests run against the dedicated database only — never the dev
  database. Gated suites wrap hooks and tests in `describe.skipIf` (see
  `src/lib/providers/config.db.test.ts`); DB suites must not run files in parallel
  (they truncate shared tables), hence `fileParallelism: false` in `vitest.config.mts`.
- No test may call a real AI provider. Provider adapters are tested against
  request-shaping and response-parsing logic with recorded fixtures; live provider
  verification belongs to the feasibility matrix task (TT-16) and is documented
  separately as evidence, not as CI.
- Fixtures: small, synthetic, and clearly not user data (approved rule: probes never
  use participant answers, stored transcripts or real interview content).
- Time-dependent logic (7-day deletion, retry backoff, 24-hour media expiry) uses an
  injected clock.

## What must always be tested (critical rules)

1. **Idempotency** — repeated `end_call`, duplicate job creation, replayed transcript
   writes (FR-ASYNC-006/007, FR-TRANSCRIPT-001–003, NFR-REL-002/004/005).
2. **Ownership & role isolation** — candidate-private data 404s for others; recruiter
   API exposes only the public-field allowlist; resume access denies instantly when
   consent is absent/revoked (FR-AUTH-005, FR-PROFILE-003/006, FR-RECRUITER-004,
   NFR-SEC-002/008, NFR-PRIV-002).
3. **Evaluation correctness** — criterion weights sum to 100 per mode, weighted score
   stays on the 1–5 scale, mode/rubric/version provenance stored, malformed scorer
   output rejected rather than displayed (FR-EVAL-008–014, NFR-REL-006/008).
4. **Assessment-unit grouping** — follow-ups attach to the active unit; a new primary
   question closes and opens units; non-assessable messages stay unit-less; the
   chronological transcript remains the untouched source of truth (FR-TRANSCRIPT-004/005).
5. **Lifecycle** — individual meeting deletion removes transcript/units/report;
   account deletion grace (export/cancel, restricted access, interview-attempt warning
   + explicit-confirm flow), expiry cascade, idempotent object-store deletion
   (FR-HISTORY-006, FR-AUTH-006–009).
6. **Provider safety** — write-only credentials never round-trip to the client; custom
   Base URL validation blocks loopback/private/metadata targets; fail-closed when a
   capability probe fails; no silent model substitution (FR-PROVIDER-006/008/009,
   NFR-SEC-004–006).
7. **Env & crypto** — boot fails fast on missing/invalid env; AES-GCM round-trip and
   key-version rotation path (ENVIRONMENT.md).

## Coverage expectations

No hard global threshold (meaningless for this codebase shape). Instead: **every
approved requirement mapped to code has at least one test or a documented manual
verification** — tracked per task in the Task Tracker and reviewed in REVIEW.md.

## Running

```bash
pnpm test                 # hermetic unit tests (no DB, no network)
TEST_DATABASE_URL=postgres://… pnpm test   # includes integration tests
pnpm verify               # lint + typecheck + test (minimum gate)
```

Integration DB policy: use a **dedicated** database (`aimis_test`), never the dev or
deployed database; integration tests must clean up what they create.

### Integration database options

| Option | Isolation | Notes |
| --- | --- | --- |
| Native Postgres, owner-managed (port 5432 — approved local dev DB) | full | Owner-created `aimis-test` database; run `pnpm prisma migrate deploy` against it once (URL swap via `TEST_DATABASE_URL`). Current local setup: `aimis` (dev) + `aimis-backup` (shadow) + `aimis-test` on PostgreSQL 17 |
| Docker compose (`docker compose up -d db`) | full | Deployment-only per owner decision (2026-11-14); still valid for a server deployment's test database |
| `pnpm prisma dev --name aimis-test` (Prisma Postgres dev) | per-server | Fallback without native Postgres; second named dev server has its own storage; run `pnpm prisma migrate deploy` against it once. Note: within ONE dev server, `CREATE DATABASE` does not isolate (PGlite shares storage), hence a separate server for tests |
| The `default` dev server | none | Dev only — do not use for `TEST_DATABASE_URL` |

Known limitation: the PGlite-backed `prisma dev` server is single-connection, so
tests that require real concurrency (evaluation worker `FOR UPDATE SKIP LOCKED`
claiming, M3) must run against the Docker Postgres.

## Evidence discipline

- Report tests executed **and not executed** in every completion report (AGENTS.md §8).
- Requirement status may move to *Implemented* with passing tests, but *Verified*
  requires the agreed acceptance evidence — never conflate the two (Notion NFR rules).
