/**
 * ASR adapter for the custom interview pipeline (TT-9; ADR-006). Uses
 * Gemini's documented `interactions` endpoint with inline audio and the
 * owner-approved `gemini-3.5-transcribe` model (free tier). The exact model id
 * is preserved; credentials are used only for this outbound call and never
 * appear in errors or logs.
 */
export interface AsrRoute {
  providerName: string;
  providerType: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

export class AsrError extends Error {
  readonly code: "generation_failed" | "empty_transcript";

  constructor(code: "generation_failed" | "empty_transcript", message: string) {
    super(message);
    this.name = "AsrError";
    this.code = code;
  }
}

export interface AsrDeps {
  fetchImpl?: typeof fetch;
}

interface InteractionResponse {
  output_text?: string;
  steps?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
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

export async function transcribeAudio(
  route: AsrRoute,
  audio: Uint8Array,
  mimeType: string,
  deps: AsrDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = route.baseUrl.replace(/\/+$/, "");
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
