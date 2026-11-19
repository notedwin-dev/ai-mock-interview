# AIMIS Requirements → Implementation Dependency Map

Phase A analysis output (2026-11-13). Sources: the Notion workspace pages and databases
listed in [README.md](./README.md) — FYP hub, scope, 88 FRs, 60 NFRs, 19 tasks,
architecture/runtime, interview & evaluation design, data model & security (incl.
dictionary v0.4 summary + 5 generated diagrams), decision register, Phase 0 plan,
academic alignment.

How to read: each FR group maps to the modules that implement it, the tasks that own
the work, and the engineering controls that satisfy the related NFRs. Requirement
text/status remain authoritative in Notion — this map is an index, not a register.

> **Register change 2026-11-16 (owner decision, recorded in Notion via MCP):** the
> agent-led interview creation flow is approved as FR-SETUP-006 and replaces the
> manual setup-form flow (FR-SETUP-001..005 remain the context data requirements,
> now gathered by the agent); scheduling (FR-SETUP-007) and invitation links
> (FR-SETUP-008) moved from parked proposals to Approved; tracker task "Implement
> interview scheduling and invitation links" is In progress. ADR-030's DeepSeek,
> Z.ai GLM and Qwen LLM presets are being added to the provider registry.

## 1. FR group → modules → tasks

| FR group (count) | Implements | Home modules | Tasks (TT) | Depends on |
| --- | --- | --- | --- | --- |
| FR-AUTH (9) | Registration, sign-in/out, one-role access, owner-scoped private data, 7-day deletion grace (request/cancel/export/permanent) | `src/lib/auth`, `(auth)` routes, account API, deletion worker | TT-10 (API design), foundation auth task (M1) | Schema v0.4 `user_account`; Argon2id (ADR-0006); Auth.js v5 |
| FR-PROFILE (6) | Candidate profile, visibility switch, public projection allowlist, career info, resume upload with unchecked-default consent, consent revoke | `(candidate)/profile`, `src/lib/profile`, resume storage route | TT-6, TT-10 | Schema v0.4 `candidate_profile`/`candidate_resume` |
| FR-SETUP (8) | Role, JD, category, evaluation mode, runtime mode selection; **agent-led conversational creation (FR-SETUP-006, replaces the manual form flow — owner decision 2026-11-16)**; scheduled ready state (FR-SETUP-007); invitation-link access with revocation (FR-SETUP-008) | `(candidate)/dashboard`, agent creation route, confirmation/waiting-room entry, session creation API | TT-6, TT-8, TT-10, new tracker task "Implement interview scheduling and invitation links" | Schema v0.4 `interview_session` snapshot fields **+ scheduled-state and invitation-token fields (new migration)**; LLM adapter for the agent |
| FR-PROVIDER (9) | Preset/custom per-capability configs, capability-scoped model settings, independent scorer, validation, discovery, runtime resolution | `src/lib/providers/*` (config, registry, probes), provider-config UI | TT-9, TT-20, TT-10 | Schema v0.4 `user_provider_configuration`; ADR-0002/0005; SSRF guard |
| FR-INTERVIEW (13) | Meeting-style room, question generation, text/voice turns, TTS speech, follow-ups, acknowledgements, mic control, local camera, end-call (candidate + agent), native realtime (High, later) | `src/lib/interview/*`, `(candidate)/room`, TT-8 room UI | TT-8, TT-9, TT-16 | FR-PROVIDER resolved config; ASR/LLM/TTS adapters |
| FR-TRANSCRIPT (6) | Finalized ordered messages (both speakers), grouping, transcript-as-source-of-truth, download | `src/lib/interview/transcript.ts`, `assessment-units.ts`, download route | TT-8, TT-15, TT-10 | Schema v0.4 `conversation_message`, `interview_assessment_unit` |
| FR-EVAL (14) | Post-completion evaluation, full transcript + per-unit scoring, summary, strengths/improvements, per-question feedback, recommended approach, 1–5 anchored modes, category adaptation, weighted score, provenance | `src/lib/evaluation/*` (scorer adapter, rubric engine, worker), report UI | TT-15, TT-17 | Interview runtime stable; ADR-0002; rubric schemas |
| FR-ASYNC (8) | Persistent job, background processing, wait/return-later, status display, bounded retries, no duplicate jobs, no webhook dependency | `src/lib/evaluation/jobs.ts`, `worker.ts` (ADR-0004), polling UI | TT-17 | `interview_evaluation` unique constraint per session |
| FR-HISTORY (6) | History list, details, report retrieval, analytics with mode context, individual meeting deletion | `(candidate)/history`, analytics view, deletion API | TT-6, TT-17, TT-18 | Lifecycle rules (ADR-023); cascades |
| FR-RECRUITER (4) | Recruiter auth, public discovery, public profile view, consent-gated resume access | `(recruiter)`, public projection serializers | Recruiter milestone (M4) | FR-PROFILE allowlist + consent state machine |
| FR-ADMIN (4, High) | Account status, category/template management, usage info, preset registry management | `(admin)`, admin APIs | TT-7 (Backlog by approved scheduling deferral) | Core candidate workflow first (approved) |
| FR-MEDIA (4, Deferred/Low) | Opt-in recording, download, manage/delete, 24-hour expiry | `src/lib/storage`, `media_recording` (Low/backlog) | Deferred (ADR-019) | Core stable; approved 24h policy |

## 2. NFR attribute → engineering controls

| NFR attribute (count) | Key controls | Where enforced |
| --- | --- | --- |
| Performance (5) | Targets are **proposed** (3 s pages, 2 s p95 app APIs) — calibrate after first vertical slice (OPEN-004); prompt transcript persistence; polling without reload; bounded queries/pagination | Server handlers, history queries, status endpoint |
| Reliability (8) | Idempotent `end_call`/job creation, transcript sequence uniqueness, persist-then-call ordering, retryable errors with backoff, reject malformed scorer output, evidence-grounded rubric audit hook | ADR-0004, transcript service, scorer validation |
| Security (8) | Server-boundary authorization + ownership checks, Argon2id (ADR-0006), AES-256-GCM (ADR-0005), write-only credentials, SSRF guards on custom endpoints, zod everywhere, recruiter isolation | `src/lib/auth`, provider probes, serializers |
| Privacy (9) | Data minimisation, owner-only interview data, local-only camera, no protected-trait inference, no model training use, content-free logs, coaching-only disclosure, approved retention/consent policies | Logging policy, room UI, report framing, deletion flows |
| Usability (8) | Meeting-style controls, speaker-labelled turns, mic status/permission recovery, clear evaluation states, actionable coaching feedback, responsive layout | TT-2 wireframe first, then room/dashboard UI |
| Compatibility (5) | Documented provider APIs only, capability-subset validation, text fallback always available | Provider registry, room input modes |
| Maintainability (7) | Component separation, adapter extension, runtime/scorer separation, rubric/contract versioning, migrations, automated critical tests, docs | This docs tree + module map (ARCHITECTURE.md §3) |
| Scalability (5) | Evaluation independent of browser connections, non-blocking session starts, bounded retrieval, SKIP LOCKED claiming, worker capacity growth | ADR-0004 |
| Deployment (5) | Docker compose, no permanent cloud for dev, env externalisation, dev/prod separation, runbook docs | README, ENVIRONMENT.md, deploy/ |

## 3. Data-model dependencies (from dictionary v0.4)

13 tables: 9 Critical MVP (`user_account`, `candidate_profile`, `user_provider_configuration`,
`interview_session`, `conversation_message`, `interview_assessment_unit`,
`interview_evaluation`, `answer_evaluation`, `evaluation_criterion_score`), 3 High
(`candidate_resume`, `interview_category`, `interview_question_template`), 1 Low
(`media_recording`). Key derived constraints to implement and test:

- one role per account (CHECK); deletion lifecycle columns on `user_account`
- unique `session_id` on `interview_evaluation` (one consolidated evaluation)
- `(session_id, sequence_number)` uniqueness on `conversation_message` (idempotent
  transcript writes, NFR-REL-002)
- `conversation_message.assessment_unit_id` nullable (non-assessable messages)
- consent columns on `candidate_resume` (`is_shared_with_recruiters`,
  `sharing_consented_at`, `consent_version`, `sharing_revoked_at`)
- weighted-score CHECK bounds (scores 1–5; weights snapshot per criterion)
- cascade deletions meeting → transcript/units/report; account → everything

## 4. Open decisions blocking or shaping work

| ID | Question | Owner | Impact if unresolved | Current stance |
| --- | --- | --- | --- | --- |
| OPEN-004 | Performance targets (3 s / 2 s p95 are proposals) | Tech lead → owner | NFR-PERF-001/002 stay unverified | Measure baseline after first vertical slice; bring realistic targets |
| OPEN-005 / OWNER-006 | O4 evaluation methodology (≥30 participants confirmed) | Supervisor | M4/O4 planning | Follow-up day is **today, Fri 13 Nov** per schedule; do not treat ~100 as required |
| OPEN-007 | Provider capability feasibility matrix | Tech lead (TT-16/TT-20) | M2 interview runtime cannot be promised | **Executed 2026-11-16**: fish-audio TTS live-validated, OpenAI-compatible wire smoke-verified — `docs/FEASIBILITY.md`; remaining presets land with M2 adapters (reported skipped, never silently validated) |
| OPEN-008 | Dictionary → ERD/migrations derivation | Tech lead (TT-3 in progress) | All schema-dependent work | Derive from v0.4, test constraints early in M1 |
| OWNER-003 | FR10 answer reattempt in scope? | Owner | History/report scope edge | Recommendation stands: defer from MVP unless owner decides |
| OWNER-007 | Detailed scoring anchors + worked examples | Tech lead drafts → owner | TT-15 rubric detail | Draft during M3 from approved weights/anchors |
| Backup expiry + log retention windows | Policy values to document | Tech lead | ADR-024 consequence incomplete | Proposed values tracked in RISKS.md; owner sign-off needed |
| AI SDK gateway choice | Record Vercel AI SDK in Notion register | Owner (record), tech lead (draft) | Decision provenance gap | Implemented per owner brief (ADR-0002); flagged in RISKS.md R-01 |

## 5. Known source conflicts (do not silently resolve)

1. **Task brief said "empty Next.js starter"** — the repo actually contains a
   documented scaffold (stack, Docker, env validation, README with deliberate
   deferrals). Impact: none on architecture (scaffold matches Notion); resolution:
   committed as baseline `f9a88ab` and treated as authoritative starting state.
2. **Vercel AI SDK** — owner-instructed in the bootstrap brief; not yet recorded in the
   Notion decision register. Impact: provenance gap only; recorded in ADR-0002 and
   flagged for the register (R-01).
3. **IR recruiter scope** vs current design: IR proposed aggregate analytics; accepted
   design is public-profile discovery only — documented in Notion as a post-IR
   refinement; implement the *current* design and describe it as a refinement (never
   quote it as IR content).

## Implementation note — scheduling and token-scoped entry (2026-11-19)

FR-SETUP-007/008 and the M2 room re-layer are implemented on the M2 feature
branch: `interview_session.status` gained `scheduled` (new interviews are born
scheduled and never auto-start), `invitation_token_hash`/`invitation_revoked_at`
carry a SHA-256-hashed 32-byte capability with revoke/reissue endpoints, and
`/i/[token]` → `/i/[token]/waiting` → `/i/[token]/room` give the interviewee a
token-scoped confirmation, local-only device preview and live room. The room
engine persists chronological speaker-attributed turns and groups them into
assessment units (primary opens a unit, follow-up joins it). Hermetic unit tests
plus TEST_DATABASE_URL integration tests cover tokens, revocation, creation and
turn persistence.
