# Provider & Voice-Pipeline Feasibility Matrix (TT-16)

Evidence record for task **TT-16** (FR-PROVIDER-006/009, open item **OPEN-007**).
Per `TESTING.md`, live provider verification is **documented evidence, never CI**:
no test may call a real AI provider; this matrix is the deliberate, one-off live
run. The provider catalogue itself is fixed by Notion ADR-030 — this document does
not re-select providers, it only verifies what the catalogue already approved.

Execution date: **2026-11-16** (M1, slice 6).

## Method and guardrails

- Live calls went through the application's own API surface (dev server + dev
  database, smoke account `smoke.candidate@example.com`), so the evidence covers
  the real request path: route → service → probe → provider.
- Probe content is synthetic only (`"ping"` text, synthesised 60-byte WAV);
  never participant answers, stored transcripts or real interview material
  (FR-PROVIDER-006 payload rule, approved).
- Secrets: the Fish Audio key entered via the API, encrypted at rest
  (ADR-0005), and never printed by scripts, logs or evidence below. Responses
  were asserted to carry no key material before capture.
- Owner constraint honored: **free model only** — `s2.1-pro-free` ($0.00 /
  M UTF-8 bytes). The paid `s2.1-pro` fallback was never triggered: the probe
  always sends the exact configured model id in the `model` request header,
  enforced by a unit test asserting that header verbatim.
- Cleanup: the created configuration was deleted after the run (HTTP 204); no
  provider-configuration residue remains.

## Matrix

| Provider (preset) | Capability | Model | Wire | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| `fish-audio` | tts | `s2.1-pro-free` | `POST /v1/tts` (native; model selected by `model` header) | ✅ **validated live** — endpoint reachable, credential accepted, audio produced | below (2026-11-16) |
| `fish-audio` | model list | — | `GET /models` | ℹ️ provider has **no OpenAI-shaped model list** (404) → discovery reports `models: null`, capability unaffected | below (2026-11-16) |
| `fish-audio` | asr | `transcribe-1-pro` | `POST /v1/asr` | ⛔ **excluded** — paid ($0.36 / audio-hour); using it requires explicit owner approval | — |
| `openai` preset + every custom OpenAI-compatible row | llm, scorer, tts, asr | configured | OpenAI wire: `GET /models`, `POST /chat/completions`, `POST /audio/speech`, `POST /audio/transcriptions` | 🔬 **wire verified** — hermetic unit tests (253 passing) + fake-endpoint live smoke 11/11 (TT-20, commit `c3108d0`); no real key involved by design | `src/lib/providers/probe.test.ts` |
| other presets (`anthropic`, `google`, …) | llm, scorer | — | M2 native adapters | ⏸ **deferred to M2** — probe reports `skipped` (never silently "validated"); configuration stays `unvalidated` | — |

## Live evidence — fish-audio TTS (2026-11-16)

12/12 smoke checks passed (`smoke-feasibility-fish.cjs`):

```
PASS signin: 302
PASS create fish-audio preset → 201: 201
PASS create response carries no key material: false
PASS created row shape: ["unvalidated",true,"fish-audio"]
PASS probe → 200: 200
PASS probe TTS validated: ["tts","validated",true,true]
PASS probe free-model header accepted, no model list consumed: [null,null]
PASS probe stores credentialStatus valid: "valid"
PASS models route → 200: 200
PASS discovery reports models:null (no OpenAI-shaped list): [true,null]
PASS listed row valid + enabled + tts capability: ["valid",true,["tts"]]
PASS cleanup deletes the fish-audio config: [204,false]
```

Captured probe result (real provider response through the app's probe route;
the one network call the probe makes for this preset):

```json
{
  "userProviderConfigurationId": "de0b615f-8cb0-4c66-b00f-e2e947a0889a",
  "providerName": "fish-audio",
  "credentialStatus": "valid",
  "capabilities": [
    {
      "capability": "tts",
      "status": "validated",
      "endpointReachable": true,
      "credentialValid": true,
      "modelsDiscovered": null,
      "selectedModelAccepted": null
    }
  ]
}
```

`selectedModelAccepted` is deliberately `null`, not `true`: without a model
list the ping cannot independently certify the exact model beyond the header
itself (the provider's documented fallback semantics make an overclaim
dishonest). `modelsDiscovered: null` matches the discovery route, which
received the provider's 404 for `GET /models`.

## Wire facts learned (input to the M2 TTS adapter)

- `POST https://api.fish.audio/v1/tts`, `Authorization: Bearer`, JSON body
  `{text, format}` → audio bytes. **Model selection is the `model` request
  header; omitting it silently serves the paid `s2.1-pro`** ($15 / M UTF-8
  bytes). The adapter must always send the configured id.
- Error mapping used by the probe (FR-PROVIDER-006 taxonomy): 401 →
  `authentication_failed`; **402 (no credit) → `rate_limited` quota family
  with the credential still valid**; 429 (concurrency limit, no Retry-After
  header) → `rate_limited`; 5xx → `provider_error`; fetch rejection →
  `network_unreachable`.
- `s2.1-pro-free` is the $0 tier of `s2.1-pro` — same model family, usable on
  a zero-credit account. Interview TTS at FYP scale is effectively free.
- No OpenAI-shaped `/models`: the provider-configuration UI cannot offer a
  model dropdown for fish-audio rows — model id entry stays free-text.
- `reference_id` (voice) is optional; the probe used the default voice. Voice
  selection for interviews is an M2 product decision, not a probe concern.
- Body formats: JSON (probe) or MessagePack (only needed for direct reference
  audio upload) — the adapter can stay JSON-only.

## M1 completion note

With this evidence, every M1 backlog slice is done, including the last open
item "configure a provider (validated)". Post-probe persistence behaved as
specified: all-validated → row stored `valid` + enabled; a failed probe
disables the row (enablement gate `probe_failed` → 409 until a material
re-save + successful re-probe). Two decisions remain flagged for the owner
from slice 5: auto-disable-on-failed-probe, and the 60 s discovery cache TTL.
