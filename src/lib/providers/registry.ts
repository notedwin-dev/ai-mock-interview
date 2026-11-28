/**
 * Provider adapter registry (approved component → module home,
 * docs/ARCHITECTURE.md §3). Preset rows reference entries here by stable
 * `providerName`; user-supplied names are never executable identity.
 *
 * This module is shared display/identity data (pure constants — no I/O, no
 * credentials), so the configuration UI imports it on the client; all
 * server-side handling of rows and keys lives in config.ts / probe.ts.
 *
 * The preset entries are the canonical public API endpoints of the eight
 * providers approved by ADR-030. Base URLs below were verified against each
 * provider's current official documentation (2026-11-16); the full model
 * catalogue (exact model_id lists, deprecation flags) is owner-maintained
 * configuration (FR-ADMIN-004) and must be cross-checked against the Notion
 * provider/model register before the configuration UI exposes anything.
 * DeepSeek, Z.ai GLM and Qwen speak the OpenAI-compatible wire, so the
 * existing probe path (GET /models + POST /chat/completions) covers them.
 */

/**
 * Capabilities a configuration row can serve. `realtime` covers the native
 * realtime agent runtimes (Gemini Live, OpenAI Realtime) — the register's
 * Option A: the provider negotiates its own realtime protocol, so the row is
 * configured like any other capability (provider + exact model ID + own
 * credential) but must never be driven over the OpenAI-compatible wires used
 * by the ASR/LLM/TTS/scorer probes.
 */
export const CAPABILITIES = ["asr", "llm", "tts", "scorer", "realtime"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface ProviderPreset {
  /** Stable machine name persisted as user_provider_configuration.provider_name. */
  providerName: string;
  displayName: string;
  /** Default Base URL for the preset connection (validated by evaluateBaseUrl). */
  defaultBaseUrl: string;
  /** Capabilities this preset can serve. */
  capabilities: readonly Capability[];
}

export const PRESET_ADAPTERS: readonly ProviderPreset[] = [
  // The scorer capability (FR-PROVIDER-003) is an LLM-style structured-output
  // call, so it is declared on presets that serve llm; tts-only presets do not
  // serve it. Custom OpenAI-compatible endpoints may serve any capability.
  {
    providerName: "openai",
    displayName: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    // `tts` = the Speech API (`POST /audio/speech`) on the same documented
    // base URL (owner decision OWNER-020, 2026-11-25). `realtime` = the
    // OpenAI Realtime API on the same documented base URL (register Option A,
    // "Pre-configured Realtime Agents"). The exact realtime model ID is fixed
    // by the administrator in `realtime-models.ts` and is never user-editable
    // or invented here.
    capabilities: ["asr", "llm", "scorer", "tts", "realtime"],
  },
  {
    providerName: "anthropic",
    displayName: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    capabilities: ["llm", "scorer"],
  },
  {
    providerName: "google",
    displayName: "Google",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    // `tts` = the Gemini TTS models on the native `POST /v1beta/interactions`
    // wire with `x-goog-api-key` (owner decision OWNER-020, 2026-11-25;
    // verified against the official speech-generation docs 2026-11-25).
    // `realtime` = the Gemini Live API on the same documented base URL
    // (register Option A, "Pre-configured Realtime Agents"). The exact realtime
    // model ID is fixed by the administrator in `realtime-models.ts`; this
    // registry never invents or substitutes one.
    capabilities: ["asr", "llm", "scorer", "tts", "realtime"],
  },
  {
    providerName: "elevenlabs",
    displayName: "ElevenLabs",
    defaultBaseUrl: "https://api.elevenlabs.io",
    // ADR-030's approved ASR preset list includes ElevenLabs (Scribe STT
    // models, retained separately from TTS IDs in the catalogue). The probe
    // verifies ElevenLabs natively (`POST /v1/text-to-speech/{model_id}` and
    // `POST /v1/speech-to-text` with `xi-api-key`).
    // `realtime` = the OpenAI-compatible Realtime API on the same base
    // (`wss://api.elevenlabs.io/v1/convai/realtime`; client secret minted
    // server-side, owner decision 2026-11-25). The exact model is admin-fixed
    // in `realtime-models.ts`; this registry never invents or substitutes one.
    capabilities: ["asr", "tts", "realtime"],
  },
  {
    providerName: "fish-audio",
    displayName: "Fish Audio",
    defaultBaseUrl: "https://api.fish.audio",
    // TTS only for now: the approved catalogue also lists Fish ASR models
    // (transcribe family), but their native wire facts land with the slice-9
    // ASR adapter — adding the capability without a verified wire would let
    // the OpenAI-shaped probe hit the wrong endpoint and fail a valid
    // credential.
    capabilities: ["tts"],
  },
  // ADR-030 additions (owner decision 2026-11-16). All three speak the
  // OpenAI-compatible wire (verified against provider docs, 2026-11-16) and
  // serve the LLM-shaped capabilities only — ASR/TTS stay on their approved
  // preset providers.
  {
    providerName: "deepseek",
    displayName: "DeepSeek",
    // Official OpenAI-format base_url per api-docs.deepseek.com (chat at
    // /chat/completions). Models: deepseek-flash, deepseek-v4-pro.
    defaultBaseUrl: "https://api.deepseek.com",
    capabilities: ["llm", "scorer"],
  },
  {
    providerName: "zai-glm",
    displayName: "Z.ai GLM",
    // Official endpoint per docs.z.ai (chat at /chat/completions). Models:
    // glm-5.3 family incl. glm-5.3-flash.
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    capabilities: ["llm", "scorer"],
  },
  {
    providerName: "qwen",
    displayName: "Qwen",
    // Alibaba Cloud Model Studio OpenAI-compatible mode. The legacy
    // international domain stays fully functional; the new workspace-specific
    // domains (https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/
    // compatible-mode/v1) are per-user and belong in the row's own Base URL
    // override, not the preset default.
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    capabilities: ["llm", "scorer"],
  },
];

export function getPresetAdapter(providerName: string): ProviderPreset | undefined {
  return PRESET_ADAPTERS.find((preset) => preset.providerName === providerName);
}

/**
 * Display-only model suggestions for the configuration UI, transcribed from
 * the approved model catalogue in the Notion System Architecture & AI Runtime
 * register (owner-maintained, FR-ADMIN-004). These are catalogue examples —
 * where a provider offers a model-list endpoint, live discovery
 * (FR-PROVIDER-009) is authoritative and the saved value must still be the
 * exact provider model_id chosen by the user; IDs are never constructed from
 * display names and never substituted.
 *
 * Scorer is an LLM-shaped structured-output call: the UI reuses each preset's
 * `llm` suggestions for it, so scorer entries are not duplicated here.
 */
export interface ModelSuggestion {
  /** Exact provider model_id (never a display name). */
  modelId: string;
  /** Catalogue note rendered next to the suggestion (preview/deprecation). */
  note?: string;
}

export const PRESET_MODEL_SUGGESTIONS: Readonly<
  Record<string, Partial<Record<Capability, readonly ModelSuggestion[]>>>
> = {
  openai: {
    asr: [
      { modelId: "gpt-transcribe" },
      { modelId: "gpt-live-transcribe" },
      { modelId: "whisper-1", note: "Deprecated" },
    ],
    llm: [
      { modelId: "gpt-6-astra" },
      { modelId: "gpt-6.1-sol" },
      { modelId: "gpt-6.1-terra" },
      { modelId: "gpt-6-luna" },
    ],
    // Speech API (`POST /audio/speech`); the current TTS family per the
    // official OpenAI speech guide (2026-11-25), all on a deprecation runway
    // (shutdown announced for 6 Jan 2027) — the register is owner-maintained
    // (FR-ADMIN-004) and must be re-verified before the UI exposes TTS.
    tts: [
      { modelId: "gpt-4o-mini-tts", note: "Deprecates 6 Jan 2027" },
      { modelId: "tts-1", note: "Lower latency; deprecates 6 Jan 2027" },
      { modelId: "tts-1-hd", note: "Higher quality; deprecates 6 Jan 2027" },
    ],
  },
  anthropic: {
    llm: [
      { modelId: "claude-opus-5-5" },
      { modelId: "claude-sonnet-5-5" },
      { modelId: "claude-haiku-5-5" },
      { modelId: "claude-fable-5-1" },
    ],
  },
  google: {
    asr: [
      { modelId: "gemini-3.5-transcribe" },
      { modelId: "gemini-3.5-transcribe-live" },
    ],
    llm: [
      { modelId: "gemini-3.6-flash" },
      { modelId: "gemini-3.5-flash" },
      { modelId: "gemini-3.5-flash-lite" },
      { modelId: "gemini-3.1-flash-lite" },
      { modelId: "gemini-3.1-pro-preview", note: "Preview" },
    ],
    // Gemini TTS on the native Interactions API wire (v1beta only, verified
    // against the official speech-generation docs 2026-11-25). Both 3.8
    // models have free tiers; paid audio output is ~$0.00225/10s
    // (gemini-3.8-flash-tts) through 31 Dec 2026.
    tts: [
      { modelId: "gemini-3.8-flash-tts", note: "Studio fidelity; free tier; paid from Jan 2027" },
      { modelId: "gemini-3.8-flash-lite-tts", note: "Fast/cost-efficient; free tier" },
    ],
  },
  elevenlabs: {
    asr: [{ modelId: "scribe_v2" }, { modelId: "scribe_v2_realtime" }],
    tts: [
      { modelId: "eleven_v4" },
      { modelId: "eleven_v4_turbo" },
      { modelId: "eleven_v3" },
      { modelId: "eleven_v3_conversational" },
      { modelId: "eleven_multilingual_v2" },
      { modelId: "eleven_flash_v2_5" },
      { modelId: "eleven_flash_v2" },
    ],
  },
  "fish-audio": {
    tts: [
      { modelId: "s2.1-pro" },
      { modelId: "s2.1-pro-free", note: "Free developer option" },
      { modelId: "s2-pro" },
      { modelId: "drama-3" },
      { modelId: "s1", note: "Retires 31 Dec 2026" },
    ],
  },
  deepseek: {
    llm: [{ modelId: "deepseek-flash" }, { modelId: "deepseek-v4-pro" }],
  },
  "zai-glm": {
    llm: [
      { modelId: "glm-5.3" },
      { modelId: "glm-5.3-flash" },
      { modelId: "glm-5.2", note: "Where still exposed" },
    ],
  },
  qwen: {
    llm: [
      { modelId: "qwen3.8-max" },
      { modelId: "qwen3.7-plus" },
      { modelId: "qwen3.8-flash" },
      { modelId: "qwen3.7-max", note: "Earlier catalogue entry" },
      { modelId: "qwen3.7-flash", note: "Earlier catalogue entry" },
      { modelId: "qwen3.6-plus", note: "Earlier catalogue entry" },
    ],
  },
};

/**
 * Per-preset overrides for the list-models wire (FR-PROVIDER-009). A preset
 * listed here negotiates its own documented list endpoint and envelope;
 * every other preset (and every custom endpoint) uses the OpenAI shape
 * (`GET {base}/models`, Bearer credential). Verified against provider
 * documentation (2026-11-16): the Gemini API lists models at
 * `GET /v1beta/models` with the key in the `x-goog-api-key` header and
 * resource names in the `models/{model_id}` shape.
 */
export interface ModelListWire {
  /** Path appended to the preset's documented Base URL. */
  path: string;
  /** How the credential travels on the list request. */
  auth: "bearer" | "x-goog-api-key";
  /** Response envelope shape. */
  format: "openai" | "google-v1beta";
}

export const PRESET_MODEL_LIST_WIRES: Readonly<Record<string, ModelListWire>> = {
  google: { path: "/v1beta/models", auth: "x-goog-api-key", format: "google-v1beta" },
};
