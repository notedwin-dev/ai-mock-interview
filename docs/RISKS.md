# AIMIS Risk & Unresolved Decision Register

Engineering-side register (2026-11-13). Notion remains authoritative for requirement
status; this file tracks *implementation* risks and the decisions the engineering
environment phase surfaced. Review at every milestone boundary.

## Risks

| ID | Risk | L×I | Mitigation | Owner |
| --- | --- | --- | --- | --- |
| R-01 | Vercel AI SDK choice is implemented (owner brief) but not yet recorded in the Notion decision register — provenance gap at documentation audit time | M×M | ADR-0002 records rationale; raise at next owner check-in; update register before feature freeze | Tech lead → Owner |
| R-02 | Provider capability assumptions fail (an "OpenAI-compatible" endpoint lacks streaming/TTS/ASR or blocks structured output) | M×H | TT-16 feasibility matrix first; fail-closed validation; no silent fallback; text fallback always available | Tech lead |
| R-03 | Schema drift between dictionary v0.4 and generated migrations (CHECK/FK/cascade mistakes) | M×H | Derive directly from v0.4 (TT-3); constraint + deletion tests in M1; ERD from reconciled schema | Tech lead |
| R-04 | 30-day window overrun — optional scope (realtime, recordings, admin) displaces core | M×H | Approved deferral order is binding; M2 demo gates M3; freeze date fixed 14 Dec | Owner |
| R-05 | Next.js 16 convention drift (agent training data ≠ installed version) | H×M | AGENTS.md next-dev block mandates `node_modules/next/dist/docs/`; reviewer checklist includes convention check | Reviewer |
| R-06 | Secrets leakage via logs, error responses or client bundle (user BYOK keys) | L×H | Write-only fields, AES-GCM, redaction policy, review checklist item, tests for non-round-trip | Implementer + Reviewer |
| R-07 | SSRF via user-supplied custom Base URLs | L×H | Server-side URL/DNS/redirect validation, private-range blocking, probes only from server | Tech lead |
| R-08 | O4 evaluation methodology unconfirmed (supervisor window ends 12 Nov; follow-up **today 13 Nov**) | M×M | escalation path documented in Notion; minimum-30 requirement fixed from IR O4 | Owner |
| R-09 | Windows host vs Linux container build differences (standalone junctions) | M×L | Build images inside Docker/Linux only (README); CI builds on Linux runners | Tech lead |
| R-10 | Auth.js v5 beta churn between now and freeze | M×M | Pin exact version; wrap session access in `src/lib/auth` seam; upgrade late only with retest | Tech lead |
| R-11 | whisper-1 (dep. 26 Feb 2027) / Fish Audio s1 (retires 31 Dec 2026) selected by users | L×L | Catalogue deprecation warnings mandated in UI; defaults point to current models | Implementer |
| R-12 | Worker bug corrupts evaluation state or duplicates reports under concurrency | L×H | SKIP LOCKED claim + unique session constraint + idempotent writes + double-claim tests (ADR-0004) | Implementer |

## Unresolved decisions (live)

| ID | Decision | Held by | Needed by |
| --- | --- | --- | --- |
| OPEN-004 | Measurable performance targets (current 3 s / 2 s p95 are proposals) | Tech lead proposes → owner approves | M4 baseline |
| OPEN-005 / OWNER-006 | O4 methodology (instrument, procedure, inclusion criteria) | Supervisor | M4 evaluation prep |
| OPEN-007 | Provider capability matrix results (execution, not a re-selection) — **executed 2026-11-16**, see `FEASIBILITY.md`; fish-audio TTS + OpenAI-compatible wire verified, other presets defer to M2 adapters | Tech lead | M2 interview runtime |
| OPEN-008 | ERD/migrations derivation sign-off from v0.4 | Tech lead | M1 schema work |
| OWNER-003 | FR10 answer reattempt — defer from MVP? | Owner | M3 history scope |
| OWNER-007 | Detailed rubric anchors + worked examples approval | Owner (tech lead drafts) | M3 evaluation |
| POL-01 | Maximum backup retention window | Tech lead to document → owner sign-off | Before M4 docs freeze |
| POL-02 | Minimal operational-log retention period (content-free logs) | Tech lead to document → owner sign-off | Before M4 docs freeze |
| POL-03 | Supported desktop browser/version matrix | Tech lead proposes | M4 compatibility testing |
| POL-04 | Load-test scenario definition (FYP-scale) | Tech lead proposes | M4 performance baseline |

Proposed policy values (explicitly **proposals**, not approved policy):
backup retention ≤ 30 days; operational log retention ≤ 14 days. Neither value may be
documented as owner-approved until sign-off (ADR-024 consequence).

## Verification hygiene reminders

- No NFR/FR may be reported *Verified* without test/acceptance evidence — approval is
  not verification (Notion register rule).
- The five existing diagrams (ERD, class, 3 sequences) are generated from v0.4 and
  approved decisions; the remaining views (system architecture, use case, DFD,
  activity) are pending TT-14 — do not cite them as existing.
