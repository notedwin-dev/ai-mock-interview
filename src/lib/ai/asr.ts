/**
 * ASR adapter for the custom interview pipeline (TT-9/TT-26; ADR-006).
 *
 * Provider-aware runtime wires (ADR-030 register + OWNER-020/021): the route is
 * dispatched on provider identity — preset name first, then the canonical
 * provider host when a custom row points at a documented endpoint — so every
 * preset model has a usable wire and nothing is silently sent to the wrong one:
 *
 * - `google` preset / generativelanguage base  → native Gemini `interactions`
 *   endpoint with inline audio (the exact configured model id is preserved).
 * - `openai` preset / api.openai.com base     → OpenAI `/audio/transcriptions`
 *   (multipart `model` + `file`, Bearer key, `{text}` response).
 * - `elevenlabs` preset / api.elevenlabs.io base → Scribe `/v1/speech-to-text`
 *   (multipart `model_id` + `file`, `xi-api-key` header, `{text}` response).
 * - every other target                         → OpenAI-compatible
 *   `/audio/transcriptions`, matching the wire the probe already verified for
 *   custom OpenAI-compatible rows (docs/FEASIBILITY.md, TT-20). Custom rows
 *   are OpenAI-compatible endpoints by the app's own contract (the probe
 *   pings them with that wire), so a custom Base URL is never "unsupported".
 *
 * A preset row whose provider name has no runtime wire (registry drift, e.g.
 * a future ASR preset before its wire lands) fails closed with a typed
 * `AsrError("unsupported")` rather than riding the generic wire at a wrong
 * host (NFR-REL-002; no silent provider/wire substitution).
 *
 * Credentials are used only for the outbound call and never appear in errors
 * or logs (NFR-SEC-008).
 */
export interface AsrRoute {
  providerName: string;
  providerType: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

export class AsrError extends Error {
  readonly code: "generation_failed" | "empty_transcript" | "unsupported";

  constructor(code: "generation_failed" | "empty_transcript" | "unsupported", message: string) {
    super(message);
    this.name = "AsrError";
    this.code = code;
  }
}

export interface AsrDeps {
  fetchImpl?: typeof fetch;
}

type AsrWire = "google" | "openai" | "elevenlabs";

interface InteractionResponse {
  output_text?: string;
  steps?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
}

function wireFor(route: AsrRoute): AsrWire | null {
  const name = route.providerName.toLowerCase();
  if (name === "google") return "google";
  if (name === "openai") return "openai";
  if (name === "elevenlabs") return "elevenlabs";
  let host: string;
  try {
    host = new URL(route.baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "generativelanguage.googleapis.com") return "google";
  if (host === "api.openai.com") return "openai";
  if (host === "api.elevenlabs.io") return "elevenlabs";
  return null;
}

function modelName(modelId: string): string {
  return modelId.startsWith("models/") ? modelId : `models/${modelId}`;
}

function extractText(body: InteractionResponse): string {
  if (typeof body.output_text === "string" && body.output_text.trim()) return body.output_text.trim();
  for (const step of body.steps ?? []) {
    for (const content of step.content ?? []) {
      if (content.type === "text" && typeof content.text === "string" && content.text.trim()) {
        return content.text.trim();
      }
    }
  }
  return "";
}

/** Builds the multipart `model` + `file` body for the transcription wires. */
function transcriptionForm(modelField: string, route: AsrRoute, audio: Uint8Array, mimeType: string): FormData {
  const form = new FormData();
  form.append(modelField, route.modelId);
  // ArrayBuffer-backed copy: Blob's strict types reject shared-buffer views.
  const bytes = new Uint8Array(audio.length);
  bytes.set(audio);
  form.append("file", new Blob([bytes], { type: mimeType }), "audio");
  return form;
}

async function transcribeMultipart(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  modelField: string,
  route: AsrRoute,
  audio: Uint8Array,
  mimeType: string,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "POST", headers, body: transcriptionForm(modelField, route, audio, mimeType) });
  } catch {
    throw new AsrError("generation_failed", "The configured speech provider could not be reached.");
  }
  if (!response.ok) {
    throw new AsrError("generation_failed", "The configured speech provider could not transcribe this audio.");
  }
  let body: { text?: unknown };
  try {
    body = (await response.json()) as { text?: unknown };
  } catch {
    throw new AsrError("generation_failed", "The configured speech provider returned an invalid response.");
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) throw new AsrError("empty_transcript", "No speech was recognised in that recording.");
  return text;
}

export async function transcribeAudio(
  route: AsrRoute,
  audio: Uint8Array,
  mimeType: string,
  deps: AsrDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = route.baseUrl.replace(/\/+$/, "");
  const wire = wireFor(route);

  // Preset rows dispatch by provider name; a preset name with no runtime wire
  // is registry drift — fail closed instead of guessing a host (NFR-REL-002).
  // Custom rows are OpenAI-compatible by the app's contract, so an unknown
  // custom host keeps the generic wire.
  if (route.providerType === "preset" && wire === null) {
    throw new AsrError(
      "unsupported",
      "This speech-recognition provider is not supported by the runtime yet.",
    );
  }

  if (wire === "elevenlabs") {
    return transcribeMultipart(
      fetchImpl,
      `${base}/v1/speech-to-text`,
      { "xi-api-key": route.apiKey },
      "model_id",
      route,
      audio,
      mimeType,
    );
  }

  if (wire === "openai" || wire === null) {
    return transcribeMultipart(
      fetchImpl,
      `${base}/audio/transcriptions`,
      { authorization: `Bearer ${route.apiKey}` },
      "model",
      route,
      audio,
      mimeType,
    );
  }

  // google native wire (unchanged shape; verified live in docs/FEASIBILITY.md).
  const payload = {
    model: modelName(route.modelId),
    input: [
      {
        type: "audio",
        data: Buffer.from(audio).toString("base64"),
        mime_type: mimeType,
      },
    ],
  };

  let response: Response;
  try {
    response = await fetchImpl(`${base}/v1beta/interactions`, {
      method: "POST",
      headers: {
        "x-goog-api-key": route.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new AsrError("generation_failed", "The configured speech provider could not be reached.");
  }
  if (!response.ok) {
    throw new AsrError("generation_failed", "The configured speech provider could not transcribe this audio.");
  }

  let body: InteractionResponse;
  try {
    body = (await response.json()) as InteractionResponse;
  } catch {
    throw new AsrError("generation_failed", "The configured speech provider returned an invalid response.");
  }
  const text = extractText(body);
  if (!text) throw new AsrError("empty_transcript", "No speech was recognised in that recording.");
  return text;
}
