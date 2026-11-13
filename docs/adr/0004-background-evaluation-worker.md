# 0004. Database-backed evaluation worker in the app process

Date: 2026-11-13
Status: Accepted
Notion mapping: ADR-017 (application-managed background jobs), ADR-018, FR-ASYNC-001…008,
NFR-SCALE-001…005

## Context

The approved evaluation lifecycle requires a persistent job record per completed
interview, processing independent of the candidate's browser, bounded idempotent
retries, and status polling — explicitly **without** provider webhooks. No queue
service is approved, and the deployment is a single docker-compose app container.

## Decision

- Job state lives on the approved `interview_evaluation` table
  (`evaluation_status`, `attempt_count`, `next_retry_at`, sanitized error fields).
- A worker loop runs **inside the app process**, started from
  `src/instrumentation.ts` when `EVALUATION_WORKER_ENABLED=1` (default on in the
  single-container deployment).
- Claiming: `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)` plus a
  status guard — safe under concurrent workers (NFR-SCALE-004).
- Retries: bounded by `EVALUATION_MAX_ATTEMPTS`, sanitized error persisted,
  `next_retry_at` backoff; malformed scorer output is rejected, not shown as complete;
  exhausted/non-retryable failures mark FAILED while the interview stays intact
  (NFR-REL-003).
- The account-deletion expiry sweep (7-day grace, FR-AUTH-009) reuses the same
  claim/update pattern with its own worker function.

## Alternatives considered

- Separate worker container/process: needed only under real load; adds deployment
  surface for an FYP-scale workload. NFR-SCALE-005 (worker capacity may grow) is still
  satisfied because the worker module is a pure function of the job table — moving it
  to its own process later is configuration, not redesign.
- Redis/BullMQ-style queue: new infrastructure the architecture does not call for.

## Consequences

- No new infrastructure; matches the approved MVP implementation decision.
- Accepted: worker availability equals app availability (single container). Restart
  safety comes from the DB job state — a crashed run leaves the job claimable again.
- Follow-up: TT-17 owns implementation; tests must cover double-claim prevention and
  idempotent result writes.
