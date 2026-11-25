/**
 * Type declarations for `./constants.mjs` — the plain-ESM runtime source of
 * truth imported by both the Next.js app (through the typed re-export in
 * `constants.ts`) and the standalone LiveKit agent worker. The module exports
 * only `const` values, so every declaration here mirrors that literal type
 * surface; a re-export through `constants.ts` narrows nothing further.
 */

export const AIMIS_REALTIME_MODEL_ID: string;
export const AIMIS_ELEVENLABS_REALTIME_MODEL_ID: string;

export const XI_API_KEY_HEADER: string;
export const X_GOOG_API_KEY_HEADER: string;
export const X_API_KEY_HEADER: string;
export const ANTHROPIC_VERSION_HEADER_NAME: string;
export const ANTHROPIC_API_VERSION: string;
export const AIMIS_WORKER_TOKEN_HEADER: string;

export const GOOGLE_OPENAI_COMPAT_PATH: string;
export const GOOGLE_INTERACTIONS_PATH: string;
export const OPENAI_COMPAT_DEFAULT_VOICE: string;

export const IDEMPOTENCY_KEY_PATTERN: RegExp;
export const IDEMPOTENCY_KEY_MAX_LENGTH: number;

export const LLM_TIMEOUT_MS: number;
export const ASR_STREAM_MAX_AGE_MS: number;

export const CAPTION_TOPIC: string;
export const LK_TRANSCRIPTION_TOPIC: string;
