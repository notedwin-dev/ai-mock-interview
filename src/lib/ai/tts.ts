/**
 * Interviewer voice adapter (TT-9; ADR-0005/006). The exact configured model
 * id is always sent: Fish Audio silently serves its PAID s2.1-pro when the
 * `model` header is omitted. Credentials are used only for this outbound
 * call; failures are sanitised so no key or provider URL reaches the UI.
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

function isFishAudio(route: TtsRoute): boolean {
  return route.providerName === "fish-audio" || /^https?:\/\/(?:[^/]*\.)?fish\.audio(?:[/:]|$)/i.test(route.baseUrl);
}

export async function synthesizeSpeech(
  route: TtsRoute,
  text: string,
  deps: TtsDeps = {},
): Promise<Uint8Array> {
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
