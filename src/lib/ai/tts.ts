import { PRESET_MODEL_SUGGESTIONS } from "@/lib/providers/registry";

/**
 * Interviewer voice adapter (TT-9/TT-26; ADR-0005/006, ADR-030 + OWNER-020/021).
 *
 * Provider dispatch: the exact configured model id is ALWAYS sent (never
 * substituted — Fish Audio silently serves its PAID s2.1-pro when the `model`
 * header is omitted, and the same rule holds for every other wire):
 *
 * - `elevenlabs` preset / api.elevenlabs.io base → native
 *   `POST {base}/v1/text-to-speech/{modelId}?output_format=mp3_44100_128`
 *   with the `xi-api-key` header and JSON `{text, model_id}`.
 *   OWNER-021 (free tier): Voice Library voices are NOT available through the
 *   API on the free plan, so no `voice` field is ever sent — the provider's
 *   default/premade voice is used, and no voice selector exists that could
 *   pick a Voice Library voice. If/when the catalogue gains a voice setting,
 *   only premade voice ids may be used.
 * - `openai` preset / api.openai.com base (or any other OpenAI-compatible
 *   target) → `POST {base}/audio/speech` with Bearer key.
 * - `google` preset → Google's OpenAI-compatible root
 *   `{base}/v1beta/openai/audio/speech`: the registry base
 *   `generativelanguage.googleapis.com` lacks the `/v1beta/openai` sub-root,
 *   and the live-verified path (docs/FEASIBILITY.md) is the OpenAI-compatible
 *   one. The Gemini **realtime** voice path is untouched and unrelated.
 * - `fish-audio` preset / fish.audio base → native `POST {base}/v1/tts` with
 *   the model selected by the `model` request header.
 *
 * Credentials are used only for this outbound call; failures are sanitised so
 * no key or provider URL reaches the UI (NFR-SEC-008). The deadline covers the
 * WHOLE request, including body consumption, so a stalled provider loses its
 * voice rather than blocking the persisted turn.
 */
export interface TtsRoute {
  providerName: string;
  providerType: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

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

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isFishAudio(route: TtsRoute): boolean {
  return (
    route.providerName === "fish-audio" ||
    hostOf(route.baseUrl) === "fish.audio" ||
    hostOf(route.baseUrl).endsWith(".fish.audio")
  );
}

function isElevenLabs(route: TtsRoute): boolean {
  return (
    route.providerName.toLowerCase() === "elevenlabs" ||
    hostOf(route.baseUrl) === "api.elevenlabs.io"
  );
}

/**
 * Google preset rows carry the registry base without the OpenAI-compatible
 * sub-root; the wire there (audio/speech) is the live-verified
 * OpenAI-compatible one (docs/FEASIBILITY.md). Custom rows keep their base.
 */
function googleOpenAiBase(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.includes("/v1beta/openai")) return base;
  return `${base}/v1beta/openai`;
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

function assertFishAudioModelSupported(route: TtsRoute): void {
  if (FISH_AUDIO_MODEL_IDS.has(route.modelId)) return;
  throw new TtsError(
    "unsupported_provider",
    "The configured Fish Audio voice model is not in the supported catalogue. Pick a listed Fish Audio model, or continue in text.",
  );
}

/** Presets whose native runtime wire is implemented here (ADR-030 + OWNER-020). */
const SUPPORTED_TTS_PRESETS: ReadonlySet<string> = new Set([
  "fish-audio",
  "elevenlabs",
  "openai",
  "google",
]);

/**
 * Pre-flight gate for the TTS wire (fail closed, FR-PROVIDER-006). Checks the
 * PURE provider rule WITHOUT a network call so callers can reject before any
 * side effect (e.g. the room checks before persisting the turn):
 *   - a preset with an implemented native/OpenAI-compatible wire is supported;
 *   - any other preset is registry drift — a typed `unsupported_provider`
 *     beats a silent 502;
 *   - custom OpenAI-compatible endpoints are supported with unrestricted ids;
 *   - Fish Audio must use a documented model id (no paid-model substitution).
 */
export function assertTtsWireSupported(route: TtsRoute): void {
  if (
    route.providerType === "preset" &&
    !SUPPORTED_TTS_PRESETS.has(route.providerName.toLowerCase())
  ) {
    throw new TtsError(
      "unsupported_provider",
      "This provider has no interviewer voice wire. Configure a supported voice provider, or continue in text.",
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
  route: TtsRoute,
  text: string,
  deps: TtsDeps = {},
): Promise<Uint8Array> {
  assertTtsWireSupported(route);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = route.baseUrl.replace(/\/+$/, "");

  let url: string;
  let headers: Record<string, string>;
  let body: string;

  if (isElevenLabs(route)) {
    // Native ElevenLabs wire. No voice field: OWNER-021 — Voice Library
    // voices are unavailable on the free tier, so the provider default is
    // used (a catalogue voice setting, if one is ever added, must be
    // restricted to premade voices).
    url = `${base}/v1/text-to-speech/${encodeURIComponent(route.modelId)}?output_format=mp3_44100_128`;
    headers = { "xi-api-key": route.apiKey, "content-type": "application/json" };
    body = JSON.stringify({ text, model_id: route.modelId });
  } else if (isFishAudio(route)) {
    url = `${base}/v1/tts`;
    headers = {
      authorization: `Bearer ${route.apiKey}`,
      "content-type": "application/json",
    };
    // Fish Audio selects the model via a request HEADER — always send it.
    headers["model"] = route.modelId;
    body = JSON.stringify({ text, format: "mp3" });
  } else {
    const openAiBase = route.providerName.toLowerCase() === "google" ? googleOpenAiBase(base) : base;
    url = `${openAiBase}/audio/speech`;
    headers = {
      authorization: `Bearer ${route.apiKey}`,
      "content-type": "application/json",
    };
    body = JSON.stringify({ model: route.modelId, input: text, voice: "alloy", response_format: "mp3" });
  }

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
