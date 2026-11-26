import type { ProviderRoute } from "@/lib/providers/provider-route";

/**
 * Interviewer voice adapter (TT-9; ADR-0005/006). The exact configured model
 * id is always sent: Fish Audio silently serves its PAID s2.1-pro when the
 * `model` header is omitted. Credentials are used only for this outbound
 * call; failures are sanitised so no key or provider URL reaches the UI.
 *
 * Provider gate (fail closed, FR-PROVIDER-006): `fish-audio` uses its native
 * `/v1/tts` wire, and custom OpenAI-compatible endpoints use the documented
 * `/audio/speech` wire. The registry also declares `tts` for `elevenlabs`
 * (and `openai`), but their native TTS wires are not implemented here — a
 * non-ElevenLabs/other-preset route is refused with `unsupported_provider`
 * before any network call instead of failing opaquely with a generic 502.
 * The ElevenLabs TTS wire is a separate, owner-approved slice.
 */
export class TtsError extends Error {
  readonly code: "unsupported_provider" | "generation_failed" | "invalid_audio";

  constructor(
    code: "unsupported_provider" | "generation_failed" | "invalid_audio",
    message: string,
  ) {
    super(message);
    this.name = "TtsError";
    this.code = code;
  }
}

export interface TtsDeps {
  fetchImpl?: typeof fetch;
}

function isFishAudio(route: ProviderRoute): boolean {
  return route.providerName === "fish-audio" || /^https?:\/\/(?:[^/]*\.)?fish\.audio(?:[/:]|$)/i.test(route.baseUrl);
}

/**
 * Pre-flight gate for the TTS wire (fail closed, FR-PROVIDER-006). Checks the
 * PURE provider rule WITHOUT a network call so callers can reject before any
 * side effect (e.g. the room checks before persisting the turn):
 *   - `fish-audio` preset / a custom endpoint on a fish.audio host → native
 *     `/v1/tts` wire, supported.
 *   - any other custom OpenAI-compatible endpoint → documented
 *     `/audio/speech` wire, supported.
 *   - any OTHER preset (elevenlabs, openai, …) → wire not implemented here;
 *     throws `TtsError("unsupported_provider")` which the route maps to 409
 *     with a typed, actionable message.
 */
export function assertTtsWireSupported(route: ProviderRoute): void {
  if (route.providerType === "preset" && route.providerName !== "fish-audio") {
    throw new TtsError(
      "unsupported_provider",
      "Interviewer voice currently supports Fish Audio and custom OpenAI-compatible voice endpoints. Configure one of those, or continue in text.",
    );
  }
}

export async function synthesizeSpeech(
  route: ProviderRoute,
  text: string,
  deps: TtsDeps = {},
): Promise<Uint8Array> {
  assertTtsWireSupported(route);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const root = route.baseUrl.replace(/\/+$/, "");
  const url = isFishAudio(route) ? `${root}/v1/tts` : `${root}/audio/speech`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${route.apiKey}`,
    "content-type": "application/json",
  };
  // Fish Audio selects the model via a request HEADER — always send it.
  if (isFishAudio(route)) headers["model"] = route.modelId;
  const body = isFishAudio(route)
    ? JSON.stringify({ text, format: "mp3" })
    : JSON.stringify({ model: route.modelId, input: text, voice: "alloy", response_format: "mp3" });

  let response: Response;
  try {
    response = await fetchImpl(url, { method: "POST", headers, body });
  } catch {
    throw new TtsError("generation_failed", "The configured voice provider could not be reached.");
  }
  if (!response.ok) {
    throw new TtsError("generation_failed", "The configured voice provider could not synthesise this turn.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new TtsError("invalid_audio", "The configured voice provider returned no audio.");
  }
  return bytes;
}
