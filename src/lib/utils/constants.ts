/**
 * Typed re-export of the shared runtime constants. The runtime source of truth
 * is `./constants.mjs` (plain ESM, also imported by the standalone LiveKit
 * agent worker); this file exists so TypeScript consumers in the Next.js app
 * import the value through a typed surface. The type declarations live in the
 * adjacent `./constants.d.mts`, which mirrors the `.mjs` literal-type surface:
 * string constants keep their literal types (e.g. the model ids and wire
 * paths), which is what callers rely on.
 */
export {
  AIMIS_ELEVENLABS_REALTIME_MODEL_ID,
  AIMIS_REALTIME_MODEL_ID,
  AIMIS_WORKER_TOKEN_HEADER,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_VERSION_HEADER_NAME,
  ASR_STREAM_MAX_AGE_MS,
  CAPTION_TOPIC,
  GOOGLE_INTERACTIONS_PATH,
  GOOGLE_OPENAI_COMPAT_PATH,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  LK_TRANSCRIPTION_TOPIC,
  LLM_TIMEOUT_MS,
  OPENAI_COMPAT_DEFAULT_VOICE,
  X_API_KEY_HEADER,
  X_GOOG_API_KEY_HEADER,
  XI_API_KEY_HEADER,
} from "./constants.mjs";
