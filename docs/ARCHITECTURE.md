# AIMIS Architecture

Status: implementation baseline (engineering environment phase).
Authority: approved requirements live in Notion; this document maps them to concrete
technology and module boundaries. Where a choice below is **not** already approved in
Notion, it is marked `[repo-decision]` and has a repo ADR under `docs/adr/`.

## 1. Approved architecture in one page

From *System Architecture & AI Runtime* (Notion) and ADR-001…030:

- Three user roles, **exactly one role per account**: Candidate (primary), Recruiter
  (public-profile discovery only), Administrator (approved High priority, scheduled
  after the core candidate workflow).
- Two **mutually exclusive** interview runtimes per session: *Pre-configured Realtime
  Agents* (later) and *Custom Configuration* (ASR/STT + LLM + TTS, built first).
- Provider credentials are **user-supplied (BYOK)**, stored per saved connection
  instance in `user_provider_configuration` (one row per instance; `capabilities_json`
  holds capability-specific model IDs/options; Custom selections never inherit another
  row's URL/key/model).
- The **SCORER is configured independently** of the live interview runtime (ADR-010).
- Interviews persist a **chronological speaker-attributed transcript**; primary
  questions, follow-ups and candidate responses are grouped into **assessment units**.
- Evaluation runs **once per completed interview**, asynchronously, in a
  **database-backed background job** with bounded, idempotent retries; the candidate
  may wait or return later. At most **one consolidated evaluation record** per session.
- Scoring: three modes (Supportive / Balanced / Rigorous) × five criteria (Relevance,
  Accuracy, Depth/Evidence, Structure/Reasoning, Communication/Reflection) with
  approved initial weights, 1–5 anchored scale, weighted overall score.
- Retention: meeting history kept until the owner deletes it (transcript, units and
  report follow that lifecycle); account deletion has a 7-day grace period with
  export/cancel, then permanent cascading deletion; optional media recording is
  **deferred** and never an AI input; camera preview is local-only.
- Recruiter access is limited to an explicit public-field allowlist and resumes with
  active, revocable, unchecked-by-default consent.

## 2. Technology stack `[approved via IR §2.4 + scaffold]`

| Concern | Choice | Notes |
| --- | --- | --- |
| Framework | Next.js 16.4 (App Router, Turbopack) | `cacheComponents` on; `output: standalone` only for Docker (`BUILD_STANDALONE=1`) |
| Language | TypeScript 5 (strict) | Front and back end |
| UI | Tailwind CSS 4 + shadcn-style copy-in components `[repo-decision]` | Radix primitives + lucide icons; see ADR-0007 |
| Database | PostgreSQL 17 | Docker Compose in dev and deployment |
| ORM | Prisma 7.10 + `@prisma/adapter-pg` (driver adapter, no query engine) | Schema derived from data dictionary v0.4 |
| Auth | Auth.js v5, credentials provider, JWT sessions `[repo-decision: details]` | Argon2id via `@node-rs/argon2` `[repo-decision]`, ADR-0006 |
| Validation | zod 4 | Shared server-side contracts |
| AI gateway | Vercel AI SDK `[owner-instructed]` | See ADR-0002; Notion register not yet updated — flagged |
| Background work | In-process worker in the app container, DB job table `[repo-decision]` | ADR-0004; no queue service |
| Secrets encryption | AES-256-GCM, master key from env `[repo-decision]` | ADR-0005 |
| Testing | Vitest (unit/integration); E2E deferred `[repo-decision]` | ADR-0003 |
| Container | Docker multi-stage + docker-compose (db/app/nginx) | Existing scaffold |
| Reverse proxy | NGINX (`client_max_body_size 100m`; HTTPS once certs exist) | Existing scaffold |
| CI | GitHub Actions `[repo-decision]` | `.github/workflows/ci.yml` |

Explicitly **not** adopted: microservices, external message queues, WebSocket
infrastructure for the report wait state (per approved design: status polling), a
separate ML/scoring service, Prettier (ESLint suffices), and any camera/recording AI
input (excluded by scope).

## 3. Runtime mapping (approved components → Next.js)

| Approved component (Notion) | Implementation home |
| --- | --- |
| Web application | `src/app` (route groups `(public)`, `(candidate)`, `(recruiter)`, `(admin)`) |
| Backend API | Next.js **route handlers** under `src/app/api/v1/**` for streaming/polling/download + **server actions** for form mutations; all authorization at this boundary |
| Provider configuration service | `src/lib/providers/config.ts` — load/validate/decrypt a user's configuration |
| Provider adapter registry | `src/lib/providers/registry.ts` — server-side preset adapters + generic OpenAI-compatible adapter; user-supplied names are never executable identity |
| Interview orchestrator | `src/lib/interview/orchestrator.ts` — turn state machine, primary/follow-up transitions, `end_call` |
| Custom pipeline | `src/lib/providers/asr|llm|tts` — capability adapters composed per session |
| Native realtime adapter | Deferred (ADR-007 build order); reserved module path `src/lib/providers/realtime/` |
| Transcript service | `src/lib/interview/transcript.ts` — finalize + persist ordered messages (idempotent) |
| Assessment grouping | `src/lib/interview/assessment-units.ts` — unit open/close; messages may be unit-less |
| Evaluation job service | `src/lib/evaluation/jobs.ts` — create/claim/track/retry one job per session |
| Evaluation worker | `src/lib/evaluation/worker.ts` — started via `instrumentation.ts`; `SELECT … FOR UPDATE SKIP LOCKED` claiming |
| Database | Prisma client singleton `src/lib/db.ts`; schema derived from dictionary v0.4 |

## 4. Frontend architecture

- **Server Components by default.** Client components only where interaction demands
  (interview room, provider configuration rows, polling status).
- Route groups mirror roles; each group is guarded by a server-side session/role check
  (`src/lib/auth/guard.ts`) — `proxy.ts` (Next 16 replacement for `middleware.ts`) does
  cheap redirects only, never authorization decisions.
- The interview room is a client-driven, meeting-style UI: mic controls, live
  transcript pane (chronological, speaker-attributed), local-only camera preview
  (`getUserMedia` without transmission), end-call control.
- Provider configuration UI mirrors the approved design exactly: three capability rows
  (ASR/STT, LLM, TTS), each with its own provider tags and its own Custom
  OpenAI-compatible sub-form (Base URL, write-only API key, required model_id,
  per-capability test action). Preset rows show capability-filtered model selectors
  with exact `model_id` visible.
- Data fetching: server components read via Prisma directly; client components call
  `/api/v1/*` handlers (typed zod contracts in `src/lib/contracts/`).

## 5. Backend / API architecture

- Mutations that are simple form posts → **server actions** (revalidate after write).
- Anything streaming (LLM turns), long-running (status polling), binary
  (transcript download, resume download) or called by the worker → **route handlers**
  under `/api/v1`.
- Every handler: authenticate session → resolve role → **ownership check on the
  resource** → zod-validate input → execute → return typed result. Ownership failures
  return 404/403 indistinguishably from missing resources (privacy).
- Idempotency: `end_call` and evaluation-job creation are unique-constrained
  (one evaluation row per session); transcript writes use sequence numbers.
- Errors: typed `AppError` → sanitized JSON problem responses; provider errors are
  classified, never swallowed, never retried across providers (fail closed, no silent
  fallback — approved rule).

## 6. AI integration architecture

```
Browser ──(app API only)──> Interview API ──> Adapter registry
                                   │               ├─ ASR adapter  (per capability config)
                                   │               ├─ LLM adapter   (AI SDK gateway)
                                   │               └─ TTS adapter  (per capability config)
                                   └─> Transcript/assessment persistence (Postgres)

Evaluation worker ──> Scorer adapter (independent config) ──> validated structured report
```

- The **AI SDK is the LLM gateway** (streamed interviewer turns via `streamText`,
  structured scorer output via `generateObject` + zod rubric schemas). Per-request
  `baseURL`/`apiKey`/`model` come from the **decrypted user configuration** — the AI
  SDK never sees a server-owned vendor key for user BYOK calls `[owner-instructed]`.
- ASR and TTS use dedicated adapters (provider-specific HTTP/WebSocket surfaces that
  the AI SDK does not standardise), e.g. OpenAI-compatible transcription endpoints,
  ElevenLabs, Fish Audio, Gemini transcribe.
- **Capability validation before use** (approved workflow, Notion): normalise/validate
  Base URL server-side; block loopback/private/link-local/metadata destinations; pin
  re-checks on redirect; discover models via the provider's list API where supported;
  require an exact `model_id`; probe the **selected capability operation** with tiny
  synthetic fixtures (never user interview data); show per-capability results;
  **fail closed**; retest on configuration change.
- Model catalogue: server-side versioned preset registry (initial catalogue from
  Notion, incl. deprecation flags: OpenAI `whisper-1` deprecated 26 Feb 2027; Fish
  Audio `s1` retires 31 Dec 2026) refreshed from provider list APIs per account.
  Saved value is always the exact `model_id`.
- The scorer rubric is versioned application configuration (`rubric_version` snapshot
  per evaluation); provider/model provenance is persisted (FR-EVAL-014).

## 7. Background evaluation worker `[repo-decision — ADR-0004]`

- Jobs live in `interview_evaluation` (approved table; job state columns already in the
  approved model: `evaluation_status`, `attempt_count`, `next_retry_at`).
- A worker loop starts with the app process via `instrumentation.ts` (single container;
  `EVALUATION_WORKER_ENABLED=0` disables it when multiple replicas exist).
- Claiming uses `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED …)` — safe under
  concurrency (NFR-SCALE-004), bounded retries with sanitized error + `next_retry_at`,
  idempotent result writes; malformed scorer output is rejected, never shown as
  complete (NFR-REL-006).
- No external queue/broker; migrating to a standalone worker process later is a
  config change, not a redesign (NFR-SCALE-005).

## 8. File and object storage

- Resume files: private storage keys under a dedicated volume (like `storage/`), served
  only through an authenticated route handler that re-checks recruiter consent at
  request time (immediate revocation, FR-RECRUITER-004). No public URLs, ever.
- Optional reference recordings: **deferred**; when implemented, opt-in metadata in
  `media_recording`, 24-hour expiry sweep, never sent to AI.
- Storage access is behind a tiny interface (`src/lib/storage/`) so an S3-compatible
  backend can replace the volume without touching call sites.

## 9. Security boundaries

1. **Client → app**: NGINX terminates traffic (TLS when certs exist); the app treats
   all client input as untrusted; zod at every boundary.
2. **App server boundary**: the only authorization point. Sessions identify the user;
   every resource access re-checks ownership/role server-side (NFR-SEC-002).
3. **App → user-configured providers**: server-side only. The browser never receives
   provider credentials (write-only fields, never returned after save) and never calls
   provider endpoints directly. SSRF guards on custom Base URLs.
4. **App → database**: single application DB role; least-privilege; all crypto of user
   credentials happens in the app (AES-256-GCM), master key outside the DB (env),
   `encryption_key_version` supports rotation (ADR-0005).
5. **Passwords**: Argon2id hashes only (ADR-021 approved; library choice in ADR-0006).
6. **Logs**: content-free operational logs — no transcripts, no secrets, no provider
   payloads (NFR-PRIV-006); bounded retention documented in RISKS.md as a proposed
   policy value.
7. **Media**: camera preview is local-only; recordings (if ever) are opt-in,
   24-hour expiry, never AI input.

## 10. Deployment architecture

- `docker compose up -d --build` → Postgres + app (non-root, standalone build) + NGINX.
- Migrations are applied at release time with `pnpm db:deploy` (documented release
  step; CI runs lint/typecheck/test/build).
- Secrets via environment only (see ENVIRONMENT.md); development and production
  configs are separated (NFR-DEP-004).
- Local dev needs no cloud: Postgres via Docker Compose **or** `pnpm db:local`
  (Prisma's bundled local Postgres).
