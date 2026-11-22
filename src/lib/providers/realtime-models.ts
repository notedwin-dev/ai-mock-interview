import type { Capability } from "./registry";
import { AIMIS_REALTIME_MODEL_ID } from "@/lib/utils/constants";

/**
 * Admin-fixed realtime models (owner decision 2026-11-20): in Pre-configured
 * mode the candidate supplies only a credential — model IDs are fixed by the
 * administrator and never user-editable. IDs below are from official provider
 * docs; unsupported/free-tier-excluded options are shown as unavailable
 * rather than invented.
 *
 * The Google entry is the model the LiveKit agent actually runs
 * (`AIMIS_REALTIME_MODEL_ID`); sourcing it from the shared constant keeps the
 * deployed worker and this catalogue from drifting apart (owner decision
 * 2026-11-23).
 */
export interface RealtimeProviderSpec {
  providerName: string;
  title: string;
  monogram: string;
  /** Fixed exact model_id, or null when no verified free-tier option exists. */
  modelId: string | null;
  note: string;
}

export const REALTIME_PROVIDERS: readonly RealtimeProviderSpec[] = [
  {
    providerName: "google",
    title: "Gemini Realtime",
    monogram: "G",
    modelId: AIMIS_REALTIME_MODEL_ID,
    note: "Free tier — no billing required.",
  },
  {
    providerName: "openai",
    title: "GPT Realtime",
    monogram: "OA",
    modelId: "gpt-realtime",
    note: "Requires a paid OpenAI account.",
  },
  {
    providerName: "elevenlabs",
    title: "ElevenLabs Realtime",
    monogram: "EL",
    modelId: null,
    note: "Realtime agent model not yet verified — setup unavailable.",
  },
  {
    providerName: "fish-audio",
    title: "FishAudio Realtime",
    monogram: "FA",
    modelId: null,
    note: "Realtime model is paid-only — not available on the free tier.",
  },
];

export function realtimeModelFor(providerName: string): string | null {
  return REALTIME_PROVIDERS.find((spec) => spec.providerName === providerName)?.modelId ?? null;
}

/** Forces the admin model for realtime rows; all other capabilities are untouched. */
export function applyRealtimeModelRules(
  capabilities: Partial<Record<Capability, { modelId: string }>>,
  providerName: string,
): Partial<Record<Capability, { modelId: string }>> {
  if (!capabilities.realtime) return capabilities;
  const fixed = realtimeModelFor(providerName);
  if (!fixed) {
    throw new Error("This realtime provider is not available.");
  }
  return { ...capabilities, realtime: { modelId: fixed } };
}
