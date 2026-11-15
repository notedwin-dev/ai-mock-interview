/**
 * Server-side provider adapter registry (approved component → module home,
 * docs/ARCHITECTURE.md §3). Preset rows reference entries here by stable
 * `providerName`; user-supplied names are never executable identity.
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

export const CAPABILITIES = ["asr", "llm", "tts", "scorer"] as const;
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
    capabilities: ["asr", "llm", "scorer"],
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
    capabilities: ["asr", "llm", "scorer"],
  },
  {
    providerName: "elevenlabs",
    displayName: "ElevenLabs",
    defaultBaseUrl: "https://api.elevenlabs.io",
    capabilities: ["tts"],
  },
  {
    providerName: "fish-audio",
    displayName: "Fish Audio",
    defaultBaseUrl: "https://api.fish.audio",
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
