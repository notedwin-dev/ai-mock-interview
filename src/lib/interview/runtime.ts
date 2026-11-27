import type { ProviderConfigSummary } from "@/lib/providers/config";
import type { InterviewSetupInput } from "./validation";

/**
 * Runtime selection (ADR-006): an interview uses exactly ONE runtime —
 * Option A (native realtime agent) OR Option B (composed custom pipeline).
 * A realtime row on its own is sufficient; ASR/LLM/TTS are only required for
 * the custom path, and the scorer never gates an interview (it gates reports).
 */
export type InterviewRuntimeMode = "realtime" | "custom" | "none";

export interface RuntimeSelection {
  mode: InterviewRuntimeMode;
  ready: boolean;
  servingProvider: string | null;
  requiredCapabilities: string[];
  row: ProviderConfigSummary | null;
}

function bestServingRow(
  rows: ProviderConfigSummary[],
  capability: "realtime" | "llm",
): ProviderConfigSummary | null {
  return (
    rows
      .filter((row) => row.isEnabled && row.capabilities[capability])
      .sort((a, b) => {
        // A validated connection must not be shadowed by an older dummy row.
        if (a.credentialStatus === "valid" && b.credentialStatus !== "valid") return -1;
        if (b.credentialStatus === "valid" && a.credentialStatus !== "valid") return 1;
        return 0;
      })[0] ?? null
  );
}

/**
 * In the realtime path the native agent gathers purpose/role/JD and asks
 * follow-ups live in the room, so launch needs no pre-chat LLM and no ASR/TTS
 * rows. Only the evaluation mode is chosen up front.
 */
export function buildRealtimeLaunchInput(
  categoryId: string,
  strictness: "supportive" | "balanced" | "rigorous",
  idempotencyKey?: string,
): InterviewSetupInput & { idempotencyKey?: string } {
  return {
    jobRole: "General practice",
    jobDescription: undefined,
    categoryId,
    evaluationMode: strictness,
    runtimeMode: "preset_realtime",
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

export function selectRuntime(rows: ProviderConfigSummary[]): RuntimeSelection {
  const realtime = bestServingRow(rows, "realtime");
  if (realtime) {
    return {
      mode: "realtime",
      ready: realtime.credentialStatus !== "invalid",
      servingProvider: realtime.providerName,
      requiredCapabilities: [],
      row: realtime,
    };
  }

  const llm = bestServingRow(rows, "llm");
  const hasCustomRows = rows.some(
    (row) => row.capabilities.llm || row.capabilities.asr || row.capabilities.tts,
  );
  return {
    mode: llm || hasCustomRows ? "custom" : "none",
    ready: Boolean(llm && llm.credentialStatus !== "invalid"),
    servingProvider: llm?.providerName ?? null,
    requiredCapabilities: llm ? [] : ["llm"],
    row: llm,
  };
}
