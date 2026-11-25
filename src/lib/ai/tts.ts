/**
 * Interviewer voice adapter (TT-9/TT-26; ADR-0005/006, ADR-030 + OWNER-020).
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
 *   one. The Gemini **realtime** voice path (realtime-token / livekit agent)
 *   is untouched and unrelated.
 * - `fish-audio` preset / fish.audio base → native `POST {base}/v1/tts` with
 *   the model selected by the `model` request header.
 *
 * Credentials are used only for this outbound call; failures are sanitised
 * so no key or provider URL reaches the UI (NFR-SEC-008).
 */
export interface TtsRoute {
  providerName: string;
  providerType: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

export class TtsError extends Error {
  readonly code: "generation_failed" | "invalid_audio";

  constructor(code: "generation_failed" | "invalid_audio", message: string) {
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
    route.providerName === "fish-audio" || hostOf(route.baseUrl) === "fish.audio" || hostOf(route.baseUrl).endsWith(".fish.audio")
  );
}

function isElevenLabs(route: TtsRoute): boolean {
  return (
    route.providerName.toLowerCase() === "elevenlabs" || hostOf(route.baseUrl) === "api.elevenlabs.io"
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

export async function synthesizeSpeech(
  route: TtsRoute,
  text: string,
  deps: TtsDeps = {},
): Promise<Uint8Array> {
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
