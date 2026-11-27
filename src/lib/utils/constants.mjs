/**
 * Shared AIMIS runtime constants.
 *
 * Kept as plain ESM (`.mjs`) so BOTH the Next.js server code and the standalone
 * LiveKit agent worker (`scripts/livekit-agent.mjs`) import the SAME value
 * without a bundler or TypeScript step. The agent image ships this file via
 * `COPY . .`; the worker imports it directly. The Next.js app imports the typed
 * re-export in `constants.ts`.
 *
 * Do NOT hardcode a provider model ID in the agent or the app: change it here
 * (and in the admin-fixed catalogue it is sourced from) so every consumer
 * stays in lockstep.
 */

/**
 * The exact model ID the LiveKit Gemini Live agent runs. Sourced from the
 * admin-fixed Google realtime entry (owner decision 2026-11-20, ADR-006): in
 * Pre-configured mode the model is fixed by the administrator and never
 * user-editable. The agent and the app derive from this single value so the
 * deployed worker and the candidate-facing configuration can never diverge.
 */
export const AIMIS_REALTIME_MODEL_ID = "gemini-3.8-live-extended-thinking";

/**
 * The exact model ID the admin-fixed ElevenLabs realtime entry mints sessions
 * with (owner decision 2026-11-25, verified against the official docs): the
 * ElevenLabs Realtime voice-agent model on the OpenAI-compatible Realtime
 * API. Sourced by the token minter (`src/lib/interview/realtime-token.ts`)
 * and the admin catalogue (`src/lib/providers/realtime-models.ts`) so the
 * configured model and the minted session can never diverge.
 */
export const AIMIS_ELEVENLABS_REALTIME_MODEL_ID = "eleven_realtime_v1_mini";

/* ------------------------------------------------------------------ */
/* Provider wire headers                                                */
/* ------------------------------------------------------------------ */

/** Credential header of every native ElevenLabs wire (Scribe ASR, native TTS, realtime client secret). */
export const XI_API_KEY_HEADER = "xi-api-key";

/** Credential header of Google's native v1beta wires (interactions endpoint, model list). */
export const X_GOOG_API_KEY_HEADER = "x-goog-api-key";

/** Credential header of the Anthropic native Messages wire. */
export const X_API_KEY_HEADER = "x-api-key";

/** Header name carrying the fixed Anthropic API version. */
export const ANTHROPIC_VERSION_HEADER_NAME = "anthropic-version";

/**
 * The fixed API version of the documented Anthropic Messages wire
 * (api.anthropic.com, /v1/messages): pinned by the provider, never per model.
 */
export const ANTHROPIC_API_VERSION = "2023-06-01";

/**
 * Header carrying the short-lived generation worker token between the LiveKit
 * worker and the app; the capability travels in the header, never in the browser.
 */
export const AIMIS_WORKER_TOKEN_HEADER = "x-aimis-worker-token";

/* ------------------------------------------------------------------ */
/* Provider wire paths and defaults                                     */
/* ------------------------------------------------------------------ */

/**
 * Google's OpenAI-compatible sub-root appended to the registry base
 * (generativelanguage.googleapis.com): the documented root for OpenAI-shaped
 * calls (chat/completions, audio/speech).
 */
export const GOOGLE_OPENAI_COMPAT_PATH = "/v1beta/openai";

/** Google's native Interactions endpoint path (batch ASR, native audio-out TTS). */
export const GOOGLE_INTERACTIONS_PATH = "/v1beta/interactions";

/** Default voice id for OpenAI-compatible TTS calls (probe and runtime agree). */
export const OPENAI_COMPAT_DEFAULT_VOICE = "alloy";

/* ------------------------------------------------------------------ */
/* Idempotency                                                          */
/* ------------------------------------------------------------------ */

/**
 * Accepted charset for client-supplied idempotency keys: 1-100 letters, digits,
 * dot, underscore, dash or colon. Mirrors the VARCHAR(100) dedup index
 * (NFR-REL-002) at every route that accepts a key.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

/** The idempotency key column width (schema v0.4 VARCHAR(100)). */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 100;

/* ------------------------------------------------------------------ */
/* Timeouts and session lifetimes                                       */
/* ------------------------------------------------------------------ */

/** Hard wall-clock bound for one LLM generation, including thinking tokens (ms). */
export const LLM_TIMEOUT_MS = 90_000;

/** Maximum lifetime of a streaming ASR session before it is reaped (ms). */
export const ASR_STREAM_MAX_AGE_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* LiveKit room topics                                                  */
/* ------------------------------------------------------------------ */

/** LiveKit room data topic for instant captions (live room and voice generation). */
export const CAPTION_TOPIC = "aimis-caption";

/** LiveKit Agents' built-in transcription text-stream topic. */
export const LK_TRANSCRIPTION_TOPIC = "lk.transcription";
