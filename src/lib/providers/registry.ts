/**
 * Server-side provider adapter registry (approved component → module home,
 * docs/ARCHITECTURE.md §3). Preset rows reference entries here by stable
 * `providerName`; user-supplied names are never executable identity.
 *
 * Status: skeleton for M1. The preset entries below are the canonical public
 * API endpoints of the providers named in the approved architecture — the
 * full model catalogue (exact model_id lists, deprecation flags) is
 * owner-maintained configuration (FR-ADMIN-004) and must be cross-checked
 * against the Notion provider/model register before the configuration UI
 * exposes anything.
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
];

export function getPresetAdapter(providerName: string): ProviderPreset | undefined {
  return PRESET_ADAPTERS.find((preset) => preset.providerName === providerName);
}
