# Candidate UI Plan — Dashboard, Interview Setup & Meeting Room (TT-2 / TT-8)

Plan for the candidate-facing UI: dashboard → new-interview setup → meeting-style
voice room. Written for backlog slice 21 (TT-2 wireframe pass, which gates slice 8's
room UI detail) and slices 8–10 (room UI, ASR/TTS adapters, orchestrator).

> **Superseded in part — see §10.** The 2026-11-16 owner decision replaces the
> setup-form creation flow (§4) with an agent-led conversational creation flow
> (FR-SETUP-006) and adds scheduling + invitation links (FR-SETUP-007/008). §4 is
> retained as the historical record; §10 is the current creation journey.

Sources of truth used: Notion FRs (all cited items **Approved**), ADR-0007 (UI
stack), `ARCHITECTURE.md` §3–4, the existing typed-slice API contracts, and the
owner-referenced UI pattern: "Full Stack AI App: Build a Real-Time Voice Agent
Interview Platform" (JavaScript Mastery, `youtube.com/watch?v=8GK8R77Bd7g`) — a
dashboard → create-interview form → real-time voice-agent room → feedback flow.

## 1. Scope rule (what is approved vs proposed)

Everything in sections 3–5 maps to an approved FR. Three elements of the referenced
video pattern were **not** covered by any approved requirement and were therefore
listed as owner proposals in §7 — they were not silently built in:

1. **Scheduling** an interview for a later time — **approved 2026-11-16** as
   FR-SETUP-007 (scheduled ready state) + FR-SETUP-008 (invitation links).
2. **Resume content as interview context** ("resume summary") — resumes are
   profile/recruiter artifacts only (FR-PROFILE-005/006); FR-INTERVIEW-002 fixes
   question context to *role + job description + category*. **Still parked (P-2).**
3. **An agent-led pre-interview briefing conversation** in the setup flow —
   **approved 2026-11-16** as FR-SETUP-006, which *replaces* the manual setup form
   as the creation path (the agent gathers the FR-SETUP-001..005 context
   conversationally and generates the structured configuration).

## 2. Information architecture (candidate route group)

```
(candidate)/guard: requireAccount({ role: "candidate" })   [exists, src/lib/auth/guard.ts]
/dashboard                     — home: status, quick actions, recent sessions   [server]
/dashboard/interview/new       — setup wizard → POST /api/v1/interviews         [client form]
/dashboard/interview/[sessionId] — meeting room (M2)                            [client]
/dashboard/history             — session list / reports (M3; entry point only)  [server]
/dashboard/profile             — resume + visibility + provider configuration    [server + client rows]
```

Navigation: top bar with Dashboard / History / Profile (+ sign-out; already present
as a server action). The dashboard is the single access point for "create a new
meeting room": the primary card routes to the setup wizard.

## 3. Dashboard spec

| Element | Behaviour | Requirement / contract |
| --- | --- | --- |
| Provider readiness card | Summarises each capability row (ASR/LLM/TTS): preset or custom, credential status (`unvalidated`/`valid`/`invalid`), enabled; deep-links to `/dashboard/profile` provider section. Shows probe state, never key material. | FR-PROVIDER-002/003/006 UI mirror of the capability rows |
| New interview card | Primary CTA → `/dashboard/interview/new`. Disabled with a fix-it link when no validated runtime route exists for the chosen default (LLM route missing → `provider_route_missing` on create otherwise). | FR-SETUP-005, FR-INTERVIEW-001 |
| Recent sessions | Last N sessions from Prisma (server component): job role, category, evaluation mode, status chip (`created`/`started`/`completed`/`failed`), created time. Rows deep-link into the room (resume) or history entry. | data path exists (`interview_session`, typed slice) |
| History / profile links | Entry points only in M2; history fills out in M3. | TT-6 |

Server component reads via Prisma directly (ARCHITECTURE §4 rule); no client
fetching on first paint.

## 4. Setup wizard spec (`/dashboard/interview/new`) — SUPERSEDED by §10

> Superseded 2026-11-16 by the agent-led creation flow (FR-SETUP-006). The form is
> not part of the current build; this section is the historical record. The
> backend payload below remains the contract the agent flow must produce.

One screen, six controls, all client-side form state — no stepper (the approved
setup is a single saved unit, FR-SETUP-001..005 acceptance criteria treat setup as
one record).

| Field | Control | Rules | FR |
| --- | --- | --- | --- |
| Target job role | Text input | Required, ≤150 chars; error state inline | FR-SETUP-001 |
| Job description | Textarea (paste-first), optional | ≤8000 chars; helper "used to contextualise questions"; char counter | FR-SETUP-002 |
| Interview category | Radio cards, exactly one | Options fetched live from `GET /api/v1/interviews/categories` (`listActiveInterviewCategories`), never hardcoded — General / Technical / Behavioral per approved data | FR-SETUP-003 |
| Evaluation mode | Radio cards, exactly one | Supportive / Balanced / Rigorous with one-line descriptions | FR-SETUP-004 |
| Runtime mode | **Stacked, mutually exclusive cards** (acceptance wording), exactly one | `Pre-configured Realtime Agents` vs `Custom Configuration`; custom card expands the per-capability readiness summary (validated ASR/LLM/TTS rows or fix-it links); scorer independence noted in card footer | FR-SETUP-005 |
| Submit | "Create interview room" | Client validation with the **shared zod contract** imported from `src/lib/interview/validation.ts` (single source of truth — client and server validate the same object); `POST /api/v1/interviews`; on 201 redirect to the room; on `provider_route_missing` → inline readiness error | FR-INTERVIEW-001 |

What the backend receives (the "craft the prompt" handoff):

```json
{ "jobRole": "…", "jobDescription": "…", "categoryId": "<uuid>",
  "evaluationMode": "supportive|balanced|rigorous",
  "runtimeMode": "preset_realtime|custom" }
```

`createInterviewSession` already snapshots the resolved LLM provider route
(`providerRouteSnapshot`, credentials excluded) and stamps
`interviewerPromptVersion`; M2 slices 9–10 consume exactly this payload for
question generation (FR-INTERVIEW-002) and the orchestrator state machine.
No other fields may be invented without an approved FR (see §7 proposals).

## 5. Meeting room spec (`/dashboard/interview/[sessionId]`)

Meeting-style interactive room (FR-INTERVIEW-003) — client component with
`getUserMedia` local preview only (FR-INTERVIEW-010: **camera is never sent to the
AI**; AGENTS.md rule preserved).

```
┌────────────────────────────────────────────────────────────────┐
│  [Agent tile: avatar + speaking state]      [Your preview]     │
│                                                                │
│  status chip: connecting ▸ waiting ▸ live ▸ ended/failed       │
│                                                                │
│  ┌ Transcript pane (chronological, speaker-attributed) ──────  │
│  │  Interviewer: …            Candidate: … (mode chip text/voice)│
│  └──────────────────────────────────────────────────────────────┘
│                                                                │
│  [Mic toggle] [Camera toggle] [End interview]                  │
│  Text answer input (always available) ─────────────── [Send]   │
└────────────────────────────────────────────────────────────────┘
```

| Control / area | Behaviour | FR |
| --- | --- | --- |
| Agent tile | Avatar + speaking indicator; spoken interviewer turns (native speech or configured TTS) drive the state | FR-INTERVIEW-006 |
| Mic toggle | Push-to-talk style control for voice turns; disabled + tooltip when the resolved runtime has no ASR capability | FR-INTERVIEW-005/009 |
| Camera toggle | Local-only preview, off by default | FR-INTERVIEW-010 |
| Transcript pane | Live, chronological, speaker-attributed; mirrors `conversation_message` ordering; includes interviewer acknowledgements/transitions as part of the flow | FR-INTERVIEW-007/008 |
| Text answer | Always present (fallback even in voice runtimes); submits `POST /api/v1/interviews/[sessionId]/turns` with `inputMode:"text"` + client-generated idempotency key (retry-safe) | FR-INTERVIEW-004, NFR-REL-002 |
| End interview | Candidate end → confirm dialog → `POST …/end` (idempotent); agent `end_call` finishes the session automatically and the UI shows the transition | FR-INTERVIEW-011/012 |
| Room states | `connecting` (snapshot loaded, adapters warm) → `waiting` → `live` → `ending` → `completed`/`failed` (failure code surfaced, re-entry allowed for report later) | lifecycle in typed slice |

The orchestrator (slice 10) owns turn transitions and `end_call`; the room renders
state — it never invents interviewer turns locally.

## 6. Component inventory (ADR-0007 pattern)

`src/components/ui/*` (copy-in on demand): button, input, textarea, radio-group,
card, dialog (end-call confirm), badge (status chips), toast (errors).
Domain components:

- `src/components/interview/SetupForm.tsx` — client; shared zod import.
- `src/components/interview/Room.tsx` (+ `TranscriptPane`, `MicControl`,
  `CameraPreview`, `EndCallButton`) — client; WebRTC-free, `getUserMedia` local.
- `src/components/dashboard/ProviderReadinessCard.tsx`, `RecentSessions.tsx`.
- Provider config UI (existing slice 4 surface formalised per ARCHITECTURE §4):
  three capability rows with per-row Custom sub-form and per-capability test
  action — TT-2 states: scanning / models found / test passed / test failed /
  manual model_id entry (free-text where no model list exists, e.g. fish-audio).

## 7. Owner proposals (not built without approval)

| # | Proposal | Why it's not in the approved FRs | Recommendation |
| --- | --- | --- | --- |
| P-1 | Schedule an interview for later (date/time, reminder) | **Approved 2026-11-16** — FR-SETUP-007 (scheduled ready state) + FR-SETUP-008 (invitation links); tracker task In progress | In scope now; reminder notifications stay out of scope |
| P-2 | Resume-aware interview context (candidate picks an uploaded resume; backend derives a summary into the prompt) | FR-PROFILE-005/006 scope resumes to profile + recruiter sharing; FR-INTERVIEW-002 fixes context to role + JD + category | Worth an owner decision — strong value for behavioural interviews; needs a new FR + data-model field (e.g. `resume_context_snapshot`) and privacy review before M3 evaluation sees it |
| P-3 | Agent-led pre-interview briefing chat in setup | **Approved 2026-11-16** — FR-SETUP-006, elevated from a pre-interview briefing to the full creation journey, replacing the manual form flow | In scope now |

## 8. Build order alignment

Dashboard + setup wizard can land with the existing typed-slice API immediately;
the room renders live interviewer behaviour only when slices 9–10 (ASR/TTS
adapters, orchestrator) land. Until then the room shows `waiting` with the text
answer path — which is already end-to-end.

## 9. Reference-design visual adaptation (round 4)

Owner mandate: the supplied design reference assets (`docs/design/references/`,
from the JavaScript Mastery interview platform kit — the same video pattern
referenced in the header) are the mandatory visual reference for layout and
presentation; the green accent is kept over the kit's lavender (owner decision),
so jade stays semantic: ready/live/primary action, amber needs attention, red
failure/leave. Adapted layouts, not copies.

### Tokens (`src/app/globals.css`)

- One dark scheme (the kit is a dark product): `--app #0b0e0c` page,
  `--surface #131815` cards, `--raised #1a201c` banners/inputs,
  `--line #262e28` borders, ink/ink-soft/ink-muted text. A faint 88px room
  grid + soft jade glow render on `body::before` beneath all content.
- `@custom-variant dark` forced via a `dark` class on `<html>` so the
  dark-tuned utility classes are scheme-independent.
- Pill geometry for controls (rounded-full), rounded-2xl/3xl cards, Bricolage
  Grotesque display + Geist body retained. Accent classes stay the fixed
  Tailwind emerald scale.

### Screen-by-screen mapping

| Reference | AIMIS screen | Adaptation |
| --- | --- | --- |
| `Auth.png` | `/signin`, `/signup` | Centred card on the grid, wordmark, labelled pill inputs, one jade pill action. AIMIS keeps its approved fields (display name, role select; no photo/resume upload — profile slice scope). |
| `Dashboard.png` | `/dashboard` | Hero banner (headline + status line + CTA + illustration) over a slim signal-chain strip (ASR/LLM/TTS readiness), then "Your past interviews" as a restrained card grid. No company-branded marketplace cards, no invented scores (evaluation is M3). |
| `Interview Confirmation.png` | `/dashboard/interview/new` | Centred card, question-style labels, selects for category/evaluation, stacked cards retained for runtime mode (FR-SETUP-005 acceptance wording), jade pill submit. |
| `Workflow Page.png` / `Interview Page.png` | `/dashboard/interview/[sessionId]` | Two-participant tiles (AI interviewer with concentric-ring avatar + You tile), full-width latest-question bar, red end action. AIMIS additions the reference lacks: chronological conversation sidebar with speaker attribution, AI thinking/listening states from real request state, explicit mic control (disabled until slices 9–10 resolve ASR), status chip + connection feedback. No "Repeat" button (no FR). |
| `Feedback.png` | Feedback/report screen | **Not implemented — blocked on the M3 evaluation backend** (no consolidated evaluation record exists yet). Planned shape: centred report column — overall impression score + date, summary paragraph, numbered per-criterion breakdown with scores and evidence bullets, verdict chip, back/retake actions. To be implemented against AIMIS's approved rubrics, assessment units, criteria and evidence when the evaluation slice lands. |
| — | `/dashboard/profile` | No reference exists; restyled onto the dark tokens with the ruled-list language. |

### Differences register (reference product → AIMIS)

- Marketplace cards with company logos/scores → real sessions only; category
  chip + status dot+word instead.
- "Repeat" question control → not covered by any FR; omitted.
- Question keyword highlight → arbitrary transcript text; omitted.
- Sign-up photo/resume upload → approved signup fields only; resume lives in
  the profile slice (FR-PROFILE-005/006).
- Feedback screen → M3 (see table).
- Camera preview (FR-INTERVIEW-010, local-only) → arrives with the voice-loop
  slices; not part of the typed-path room.

## 10. Flow correction (2026-11-16 owner decision)

Owner mandate: a product-flow correction, not a visual redesign. The implemented
creation flow deviated from the product's intended journey; the corrected journey
is mandatory and the manual setup form is retired as the creation path.

### 10.1 Approved journey (acceptance path)

```
/dashboard  "Launch AI Interview Agent" (primary CTA)
   └─ /dashboard/interview/agent      conversational agent gathers purpose /
                                      role / JD + strictness (Supportive /
                                      Balanced / Rigorous)  [FR-SETUP-006]
   └─ generated structured configuration shown to the user
   └─ auto-create interview in scheduled/ready state   [FR-SETUP-007]
        (no manual form between generation and creation)
   └─ interviewee entry — owner route or invitation link /i/[token]  [FR-SETUP-008]
   └─ confirmation screen  (pre-configured details, review-and-confirm)
   └─ waiting room  (camera preview local-only, mic/speaker selection +
      status, meeting details, explicit "Join Call"; no auto-start)
   └─ live interview room  (two participant panels, AI states; conversation
      is an independently openable OVERLAY, not a sidebar)
   └─ completion → transcript finalised → separately configured scorer
      → approved evaluation architecture → feedback report
      (summary, overall score + mode, criteria + evidence, strengths,
      improvements, per-assessment-unit feedback)  [FR-EVAL/FR-ASYNC]
```

### 10.2 Route-level corrections

| Route | Change | FR / basis |
| --- | --- | --- |
| `/dashboard` | Primary CTA becomes **Launch AI Interview Agent** (agent route); provider-readiness signal chain stays | FR-SETUP-006 |
| `/dashboard/interview/agent` | **Implemented (2026-11-19, `577fbb0`).** Conversational agent → generated configuration review → auto-create; `POST /api/v1/interviews/agent` (`turn`/`create`) runs generation and session creation server-side with the configured LLM. Dashboard primary CTA now launches the agent; manual setup form remains a fallback | FR-SETUP-006 |
| `/dashboard/interview/[sessionId]` | Re-layered: confirmation → waiting room → live room states; conversation becomes an overlay panel | FR-INTERVIEW-003/010, FR-SETUP-007 |
| `/i/[token]` | **Implemented.** Invitation-link confirmation (token → one interview only), then `/i/[token]/waiting` (explicit device checks, local-only preview, explicit Join Call) and `/i/[token]/room` (two participant panels, AI states, independently openable conversation overlay). Owner receives the copyable link at creation; revoke/reissue via `POST /api/v1/interviews/[sessionId]/invitation` | FR-SETUP-007/008 |
| `/dashboard/configuration` | **New.** Dedicated AI configuration experience (distinct preset vs Custom modes; per-capability expandable sections ASR/LLM/TTS with provider chips; per-capability Custom OpenAI-compatible URL/key/model; model discovery + probe + readiness; independent scorer section) | FR-PROVIDER-001..009, ADR-028/029/030 |
| `/dashboard/interview/new` | Retired as creation path (SetupForm superseded; may remain as a direct-create fallback only if the owner asks) | FR-SETUP-006 supersedes |
| `/dashboard/history` | Unchanged plan; fills out with reports in M3 | FR-HISTORY |

### 10.3 Rules carried into the corrected flow

- Camera input is local preview only — never AI input (ADR-005, AGENTS rule).
- No auto-start: scheduled interviews start only after an explicit join action
  (FR-SETUP-007).
- No configuration inheritance or silent provider substitution across
  capabilities; the scorer is configured independently of the interview LLM
  (ADR-028/029; FR-PROVIDER).
- Rubric mode (Supportive/Balanced/Rigorous) is an evaluation decision, distinct
  from the interview LLM choice and the scorer choice.
- All new authorization (invitation links) is enforced server-side at the
  boundary; links open exactly one interview and are revocable (FR-SETUP-008).

### 10.4 Build order (backlog slices 8–15)

1. Provider registry presets (DeepSeek, Z.ai GLM, Qwen — ADR-030 gap closed) +
   `/dashboard/configuration` experience (existing probe/models APIs).
2. LLM adapter + orchestrator (slices 9–10) — powers both the creation agent and
   the in-room interviewer.
3. Agent creation flow, confirmation screen, waiting room, overlay room.
4. Scheduling + invitation links (schema migration + server-side authorization).
5. Evaluation job/worker/scorer (M3 slices 12–13) + report UI + history route.

### 10.5 Configuration page restructure (2026-11-16 owner mockup, implemented)

The owner supplied the definitive `/dashboard/configuration` design; the page
now mirrors the approved runtime architecture (ADR-006) with two mutually
exclusive interview runtime options. Which option runs an interview is chosen
at interview creation, not on this page.

- **Option 1 — Pre-configured Realtime Agents** (badge "Native integrations"):
  provider cards Gemini Live (`google` preset) and OpenAI Realtime (`openai`
  preset) with monogram tiles; explainer: users don't configure separate ASR,
  LLM and TTS models in this mode. One row per provider: without a stored row
  the card creates one (`realtime` capability only); with one, it PATCHes the
  `realtime` capability onto the stored row (credential untouched). Configured
  rows get the same row-card controls as Option 2. Realtime model IDs are
  discovery/manual entry only — the owner-maintained catalogue lists no
  realtime agent model IDs, so none are invented. Probes always report
  `skipped` (status-neutral) until the realtime runtime slice lands.
- **Option 2 — Custom Configuration** (badge "Composable pipeline"):
  collapsible sections ASR/STT, LLM, TTS and the independent scorer with the
  mockup subtitles ("Speech recognition provider and model", "Interview
  conversation, question generation and follow-ups", "Interviewer speech
  synthesis provider and model"); footer: users independently select providers
  and models for each capability. The scorer stays a fourth section under
  Option 2 per FR-PROVIDER-003 (the mockup crop does not show it; the approved
  requirement does).
- The capability readiness strip (ASR/LLM/TTS/Scorer, honest per-capability
  states) stays at the top of the page above both option cards.
- Registry: `CAPABILITIES` gained `realtime`; the `openai` and `google` presets
  declare it (Gemini Live / OpenAI Realtime on their documented base URLs).
  `probe.ts` guards realtime per capability so native realtime rows never hit
  the OpenAI-compatible probe wires.
- **Model setup is list-driven (owner directive 2026-11-16, same day):** every
  model picker waits for the API key, then lists the provider's models via the
  list-models API and the user picks — no manual ID typing by default.
  Pre-create forms call the transient `POST /api/v1/providers/discover-models`
  (key used once, never stored); stored rows use the per-row endpoint with the
  stored key. Google's native list wire (`GET /v1beta/models`,
  `x-goog-api-key`, `models/{id}` names) is honoured through
  `PRESET_MODEL_LIST_WIRES` in the registry; other presets use the OpenAI
  shape. Fallback order: live discovery → approved catalogue (pick list, never
  typing) → manual entry only for a custom endpoint with neither. Realtime
  cards are strict pick-only (both target providers expose list endpoints).
