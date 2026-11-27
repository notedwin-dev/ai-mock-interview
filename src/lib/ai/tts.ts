import { PRESET_MODEL_SUGGESTIONS } from "@/lib/providers/registry";
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
 * The documented Fish Audio model catalogue (owner-maintained register,
 * FR-ADMIN-004). The native wire always sends the configured id in the `model`
 * header, so an unrecognised id would reach Fish Audio and fail opaquely (or
 * silently serve a different paid model). Rejecting it up front keeps the
 * failure typed and leaves custom OpenAI-compatible ids unrestricted.
 */
const FISH_AUDIO_MODEL_IDS: ReadonlySet<string> = new Set(
  (PRESET_MODEL_SUGGESTIONS["fish-audio"]?.tts ?? []).map((model) => model.modelId),
);

function assertFishAudioModelSupported(route: ProviderRoute): void {
  if (FISH_AUDIO_MODEL_IDS.has(route.modelId)) return;
  throw new TtsError(
    "unsupported_provider",
    "The configured Fish Audio voice model is not in the supported catalogue. Pick a listed Fish Audio model, or continue in text.",
  );
}

/**
 * Pre-flight gate for the TTS wire (fail closed, FR-PROVIDER-006). Checks the
 * PURE provider rule WITHOUT a network call so callers can reject before any
 * side effect (e.g. the room checks before persisting the turn):
 *   - `fish-audio` preset / a custom endpoint on a fish.audio host → native
 *     `/v1/tts` wire with a documented model id, supported.
 *   - any other custom OpenAI-compatible endpoint → documented
 *     `/audio/speech` wire, supported (ids are not restricted there).
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
  if (isFishAudio(route)) assertFishAudioModelSupported(route);
}

/**
 * One turn's audio is a per-turn enhancement, never a blocker (FR-INTERVIEW-003):
 * the reply is already persisted when synthesis runs, so a stalled provider must
 * lose its voice, not the turn. The deadline bounds the WHOLE request — connect,
 * headers AND body consumption — because a provider can stream headers promptly
 * and then stall mid-audio.
 */
const SYNTHESIS_TIMEOUT_MS = 30_000;

/** Settles with the promise unless the deadline aborts first. */
function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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

  const deadline = AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "POST", headers, body, signal: deadline });
  } catch {
    throw new TtsError("generation_failed", "The configured voice provider could not be reached.");
  }
  if (!response.ok) {
    throw new TtsError("generation_failed", "The configured voice provider could not synthesise this turn.");
  }
  let bytes: Uint8Array;
  try {
    // Body consumption is raced against the same deadline: fetch aborting the
    // socket is not guaranteed to reject a half-read body on every runtime.
    bytes = new Uint8Array(await withDeadline(response.arrayBuffer(), deadline));
  } catch {
    throw new TtsError("generation_failed", "The configured voice provider did not finish synthesising this turn.");
  }
  if (bytes.length === 0) {
    throw new TtsError("invalid_audio", "The configured voice provider returned no audio.");
  }
  return bytes;
}
