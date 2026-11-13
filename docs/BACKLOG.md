# AIMIS Implementation Backlog & Milestone Plan

Status: engineering-environment phase (2026-11-13). **The Task Tracker in Notion is the
authoritative task register** — this backlog maps proposed engineering milestones onto
it and proposes the new tasks that the environment work created. It is not a second
tracker: once a task starts, its status lives in Notion.

Timeline authority: Notion *Phase 0 & Development Plan* (submission 16 Dec 2026;
effective window 16 Nov – 16 Dec ≈ 30 days; presentation week of 4 Jan 2027).

## Milestones

| Milestone | Window (Notion plan) | Goal | Exit evidence |
| --- | --- | --- | --- |
| M0 — Environment (this phase) | now → 15 Nov (academic break) | Engineering environment, requirements analysis, provider/database/worker design decisions | This docs tree, ADRs, CI, verify gate green; Phase 0 exit checklist items owned by tech lead advanced |
| M1 — Foundation | 16–22 Nov | Auth, profiles, provider configuration persistence + discovery service skeleton, **first typed vertical slice** (minimal interview path: typed text turn → persisted transcript) | Candidate can authenticate, configure a provider (validated), and complete a minimal typed interview; schema migrations derived from v0.4 |
| M2 — Core interview | 23–29 Nov | Custom pipeline (ASR/LLM/TTS), meeting room UI, voice loop, follow-ups, assessment-unit grouping | Working custom interview with chronological transcript and follow-ups (TT-8, TT-9, TT-16/20 evidence) |
| M3 — Evaluation | 30 Nov – 6 Dec | Rubric engine, scorer adapter, background worker, report UI, history + progress analytics, deletion controls | End-to-end interview→report workflow (TT-15, TT-17), meeting deletion (TT-18 partial) |
| M4 — Boundaries & quality | 7–13 Dec | Recruiter public-profile access, account-deletion grace flow, security/usability testing, performance baseline (OPEN-004), admin deferral kept | Stable core MVP; consent/retention tests; baseline measurements recorded |
| M5 — Freeze | 14–16 Dec | Feature freeze, regression, final report/code submission | Submission package |
| Presentation | Week of 4 Jan 2027 | Demo + defence readiness | Demo script rehearsed |

Optional work (native realtime runtime, recordings, admin dashboard) must not displace
the core workflow — approved rule.

## Workstream → task mapping (TT = Notion Task Tracker ID)

| # | Work item | TT | Priority | Milestone |
| --- | --- | --- | --- | --- |
| 0.1 | ~~Commit scaffold baseline~~ | — | Critical | M0 ✅ `f9a88ab` |
| 0.2 | Engineering docs + ADRs + CI + verify gate | — | Critical | M0 ✅ this commit |
| 0.3 | Agent role definitions wired (.opencode/agent) | — | High | M0 ✅ this commit |
| 0.4 | Add `TEST_DATABASE_URL` integration-test harness when first DB test lands | — | Medium | M1 |
| 1 | Derive Prisma schema + initial migration from dictionary v0.4; constraint tests | TT-3 | Critical | M1 |
| 2 | Auth.js v5 + Argon2id registration/sign-in; role model; session guards | TT-10 (slice) | Critical | M1 |
| 3 | Candidate profile + visibility + resume upload (private default) | TT-6 (slice) | Critical | M1 |
| 4 | Provider configuration CRUD + AES-256-GCM encryption (write-only keys) | TT-10/TT-20 | Critical | M1 |
| 5 | Provider discovery + capability probe service (SSRF guards, fail closed) | TT-20 | Critical | M1→M2 |
| 6 | Provider/voice-pipeline feasibility matrix (live evidence, no CI) | TT-16 | Critical | M1→M2 |
| 7 | Typed vertical slice: minimal interview session + transcript persistence | TT-8/TT-10 | Critical | M1 |
| 8 | Meeting-style room UI + mic controls + local camera preview | TT-8, TT-2 | Critical | M2 |
| 9 | ASR + TTS adapters wired to validated capability configs | TT-9 | Critical | M2 |
| 10 | Interview orchestrator: turns, follow-ups, acknowledgement, end_call (idempotent) | TT-8 | Critical | M2 |
| 11 | Assessment-unit grouping service | TT-8/TT-15 | Critical | M2 |
| 12 | Rubric engine (weights, anchors, category adaptation) + scorer adapter | TT-15 | Critical | M3 |
| 13 | Evaluation worker (claim/retry/idempotent writes) + status polling + report UI | TT-17 | Critical | M3 |
| 14 | History, report retrieval, progress analytics with mode context | TT-6 | Critical | M3 |
| 15 | Meeting deletion + transcript/report lifecycle | TT-18 | Critical | M3 |
| 16 | Account deletion grace flow (restricted access, export, cancel, warning-confirm) | TT-18 | Critical | M4 |
| 17 | Recruiter registration + public discovery/view + consent-gated resume access | TT-6 slice | Critical | M4 |
| 18 | Performance baseline measurement → proposed targets (OPEN-004) | — | High | M4 |
| 19 | Security/usability test pass + O4 prep (30 participants, methodology per supervisor) | TT-19 | High | M4 |
| 20 | Admin dashboard (account status, categories/templates, usage, preset registry) | TT-7 | High | After core (approved deferral) |
| 21 | Wireframe pass for runtime cards + capability rows + report states | TT-2 | High | Before M2 UI |
| 22 | Diagram completion pass (architecture, use case, DFD, activity) | TT-14, TT-3/4/5 | High | M0→M4 |
| 23 | Landing page | TT-1 | Low | M4 |

Dependencies that gate M1: 1 → 2/3/4 → 7; 5 gates M2's 9; 21 gates 8's UI detail.

## Proposed new Task Tracker entries (owner to confirm before adding)

1. **Implement provider configuration persistence + encryption** (splits TT-20's
   storage half from its probing half) — Critical, M1.
2. **Typed vertical slice interview path** — Critical, M1 (creates the integration
   seam everything else hangs off).
3. **Account-deletion grace flow implementation** (splits from TT-18's retention
   documentation half) — Critical, M4.
