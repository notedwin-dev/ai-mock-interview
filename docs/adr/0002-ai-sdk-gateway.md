# 0002. Use the Vercel AI SDK as the LLM gateway behind the approved adapter registry

Date: 2026-11-13
Status: Accepted (owner-instructed in the engineering-environment brief)
Notion mapping: ⚠ **no Notion decision record yet** — flagged to the owner for the
decision register (see RISKS.md R-01). Notion ADR-030 fixes the *provider catalogue*;
the gateway library choice is this repo's engineering detail.

## Context

The approved architecture requires a provider adapter registry (preset + generic
OpenAI-compatible adapters), streamed interviewer turns, structured scorer output
validated against zod rubric schemas, per-request `baseURL`/`apiKey`/`model` from the
decrypted user configuration (BYOK), exact `model_id` preservation, and no silent
provider switching. The IR leaves the LLM SDK open (§2.4.5). The project owner
instructed, in the bootstrap brief, that the approved choice is the Vercel AI SDK.

## Decision

- Use **Vercel AI SDK** as the LLM call layer: `streamText` for interviewer turns,
  `generateObject` with zod schemas for scorer output.
- Per-request provider configuration (base URL, key, exact model id) is constructed
  from the user's decrypted `user_provider_configuration` row; the SDK is never
  configured with server-owned vendor keys for user BYOK calls.
- The adapter registry remains the seam: capability validation, probes, error
  classification and fail-closed behaviour wrap the SDK, so a provider that cannot be
  expressed through it still gets a bespoke adapter.

## Alternatives considered

- Raw `fetch` wrappers per provider: maximum control, but we would hand-roll streaming,
  structured output, retries and typing the SDK provides; slower with a 30-day window.
- LangChain: heavier abstraction, less aligned with streaming-first App Router usage.

## Consequences

- Faster compliant implementation of streaming + structured evaluation.
- Accepted: SDK versions move fast; pin versions and re-verify against the provider
  capability matrix (TT-16/TT-20).
- Accepted: exotic OpenAI-compatible endpoints may still need bespoke adapters — the
  registry is the stable contract (NFR-MAINT-002).
- Follow-up: owner to record the AI SDK decision in the Notion decision register
  (change-control rule); do this before feature freeze documentation.
