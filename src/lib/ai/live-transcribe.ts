/**
 * Streaming ASR for Google's `gemini-3.5-transcribe-live` via the Gemini Live
 * WebSocket API. The exact configured model id is preserved and the credential
 * is used only for the outbound socket — never returned to the client.
 *
 * This is the preferred custom-path ASR mode when the candidate configures a
 * live-transcribe model. Providers/models without a streaming endpoint keep
 * using the batch `/v1beta/interactions` adapter in `asr.ts`.
 */
import type { AsrRoute } from "./asr";

export interface LiveTranscriptionSession {
  /** Send 16 kHz 16-bit mono PCM, base64 encoded. */
  sendAudio(base64Pcm: string): void;
  /** Signal end of the current utterance so the provider flushes its transcript. */
  endAudioStream(): void;
  close(): void;
  readonly closed: boolean;
}

interface LiveCallbacks {
  onTranscript(text: string): void;
  onError(message: string): void;
  onClose(): void;
}

const LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService/BidiGenerateContent";

/** True when the configured ASR model is a Gemini Live transcription model. */
export function isLiveTranscribeModel(modelId: string): boolean {
  return modelId.includes("transcribe-live");
}

function modelName(modelId: string): string {
  return modelId.startsWith("models/") ? modelId : `models/${modelId}`;
}

/**
 * Open a Live API session for transcription-only. The browser never speaks to
 * Google directly; audio is relayed through the app route, so the key stays
 * server-side. Node 22 provides a global WebSocket.
 */
export function openLiveTranscription(
  route: AsrRoute,
  callbacks: LiveCallbacks,
): LiveTranscriptionSession {
  const url = `${LIVE_ENDPOINT}?key=${encodeURIComponent(route.apiKey)}`;
  const socket = new WebSocket(url);
  let closed = false;

  const send = (value: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  };

  socket.addEventListener("open", () => {
    send({
      setup: {
        model: modelName(route.modelId),
        generationConfig: { responseModalities: ["TEXT"] },
        inputAudioTranscription: {},
      },
    });
  });

  socket.addEventListener("message", (event: MessageEvent<string>) => {
    try {
      const message = JSON.parse(typeof event.data === "string" ? event.data : "") as {
        serverContent?: {
          inputTranscription?: { text?: string };
          turnComplete?: boolean;
        };
      };
      const text = message.serverContent?.inputTranscription?.text;
      if (text?.trim()) callbacks.onTranscript(text.trim());
    } catch {
      // Ignore malformed provider frames; the session stays usable.
    }
  });

  socket.addEventListener("error", () => {
    callbacks.onError("The live transcription provider could not be reached.");
  });

  socket.addEventListener("close", () => {
    closed = true;
    callbacks.onClose();
  });

  return {
    sendAudio(base64Pcm: string) {
      send({ realtimeInput: { audio: { data: base64Pcm, mimeType: "audio/pcm;rate=16000" } } });
    },
    endAudioStream() {
      send({ realtimeInput: { audioStreamEnd: true } });
    },
    close() {
      if (closed) return;
      closed = true;
      socket.close();
    },
    get closed() {
      return closed;
    },
  };
}
