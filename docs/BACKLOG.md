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

> **Scope correction 2026-11-16 (owner decision):** the creation flow was corrected
> to the approved agent-led journey (FR-SETUP-006), and scheduling + invitation
> links moved from parked proposals to Approved (FR-SETUP-007/008; tracker task
> created and In progress). Work items 24–27 below carry the new scope; 8's room
> plan is re-layered (confirmation → waiting room → overlay-conversation room).
> The full ADR-030 preset set (incl. DeepSeek, Z.ai GLM, Qwen) is in scope for
> item 24. See docs/UI-PLAN.md §10.

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
| 9 | ASR + TTS adapters wired to validated capability configs ✅ (Gemini `gemini-3.5-transcribe` free tier + Fish `s2.1-pro-free`; free-tier end-to-end loop verified) | TT-9 | Critical | M2 |
| 10 | Interview orchestrator: turns, follow-ups, acknowledgement, end_call (idempotent) ✅ (token-scoped turn engine; LLM-driven primary/follow-up/transition; endCall) | TT-8 | Critical | M2 |
| 11 | Assessment-unit grouping service ✅ (primary opens a unit, follow-ups join, retry idempotent on candidate key) | TT-8/TT-15 | Critical | M2 |
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
| 24 | AI configuration experience `/dashboard/configuration` + registry presets completed (DeepSeek, Z.ai GLM, Qwen; distinct preset/Custom modes, per-capability sections, discovery + probe + readiness, independent scorer) | TT-20 | Critical | M2 |
| 25 | Agent-led interview creation: conversational agent → structured configuration → auto-create ready interview ✅ `577fbb0` (feature branch; PR to staging pending) | TT-8 | Critical | M2 |
| 26 | Interview entry re-layer: confirmation screen → waiting room (device checks, local-only camera) → live room with overlay conversation ✅ (token-scoped entry, local preview, overlay room) | TT-8, TT-2 | Critical | M2 |
| 27 | Scheduling + invitation links: schema migration (scheduled state, token + revocation), token-scoped `/i/[token]` entry, server-side authorization ✅ (hash-at-rest token, revoke/reissue, DB-backed tests) | TT-10 (new tracker task) | Critical | M2 |

**M2 exit evidence (2026-11-20):** a complete free-tier custom interview runs
agent creation → scheduled interview + invitation → token-scoped confirmation
and waiting room → live room with push-to-talk Gemini ASR, Gemini LLM
primary/follow-up turns with assessment-unit grouping, and Fish free TTS
audio. Verified end-to-end via the app API (transcript 200, turn 200, MP3
~308 KB) and `pnpm verify` (314/314). Notion tracker statuses for TT-8/9/21
were left unchanged — updating the register needs owner authorisation.

**Realtime transport note (2026-11-20, owner direction: Gemini only):** the
room now supports a native Gemini Live **WebSocket** realtime session (ADR-006
Option A) via AI SDK `experimental_useRealtime`; ephemeral credentials come
from `/realtime/token`, finalized transcript events from `/realtime/transcript`.
Next.js route handlers cannot host WebSocket upgrades, so an app-owned relay
is not used — the SDK connects the browser directly to Gemini with the
short-lived token. **WebRTC is not available with Gemini**: official Gemini
Live docs specify a stateful WSS protocol and the installed SDK declares
`transports: ["websocket"]` (no WebRTC); Google lists third-party gateways
(LiveKit, Pipecat, Fishjam, Agora) for WebRTC. Implementing a WebRTC room needs
a gateway/credential decision from the owner — it is not invented here.

Dependencies that gate M1: 1 → 2/3/4 → 7; 5 gates M2's 9; 21 gates 8's UI detail.
Dependencies added 2026-11-16: 24 → 25 (the creation agent needs a configured,
validated LLM); 25 → 27 (scheduled state + link target the generated interview);
27 gates the invitation-link entry; 26's confirmation/waiting-room layering reads
the scheduled state from 27.

## Proposed new Task Tracker entries (owner to confirm before adding)

1. **Implement provider configuration persistence + encryption** (splits TT-20's
   storage half from its probing half) — Critical, M1.
2. **Typed vertical slice interview path** — Critical, M1 (creates the integration
   seam everything else hangs off).
3. **Account-deletion grace flow implementation** (splits from TT-18's retention
   documentation half) — Critical, M4.
