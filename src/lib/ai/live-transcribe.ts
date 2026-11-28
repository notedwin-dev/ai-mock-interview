/**
 * Streaming ASR for Google's `gemini-3.5-transcribe-live` via the Gemini Live
 * WebSocket API. The exact configured model id is preserved and the credential
 * is used only for the outbound socket — never returned to the client.
 *
 * This is the preferred custom-path ASR mode when the candidate configures a
 * Google preset serving a live-transcribe model. Providers/models without a
 * streaming endpoint keep using the batch `/v1beta/interactions` adapter in
 * `asr.ts`.
 */
import type { AsrRoute } from "./asr";

export interface LiveTranscriptionSession {
  /** Send 16 kHz 16-bit mono PCM, base64 encoded. Only accepted when ready. */
  sendAudio(base64Pcm: string): void;
  /** Signal end of the current utterance so the provider flushes its transcript. */
  endAudioStream(): void;
  close(): void;
  readonly closed: boolean;
  /** True only after the provider acknowledged setup with `setupComplete`. */
  readonly ready: boolean;
}

interface LiveCallbacks {
  onTranscript(text: string): void;
  onError(message: string): void;
  onClose(): void;
  /** Fired once, after the provider accepts audio. */
  onReady?(): void;
  /** Fired when the provider reports a completed turn (final transcript). */
  onFinal?(): void;
}

const LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService/BidiGenerateContent";

/** True when the configured ASR model is a Gemini Live transcription model. */
export function isLiveTranscribeModel(modelId: string): boolean {
  return modelId.includes("transcribe-live");
}

/**
 * Only a Google preset serving a live-transcribe model may use this bridge —
 * it always dials Google's endpoint. Custom routes carry a credential for a
 * different provider, so passing them here would silently switch providers.
 */
export function isLiveTranscribeRoute(route: {
  providerName: string;
  providerType: string;
  modelId: string;
}): boolean {
  return (
    route.providerType === "preset" &&
    route.providerName === "google" &&
    isLiveTranscribeModel(route.modelId)
  );
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
  let ready = false;

  // The setup frame must go out before setupComplete; every subsequent frame
  // is gated on readiness so audio is never silently dropped mid-connection.
  const rawSend = (value: unknown) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(value));
    } catch {
      /* socket closed between the state check and send */
    }
  };
  const send = (value: unknown) => {
    if (!ready || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(value));
    } catch {
      /* socket closed between the state check and send */
    }
  };

  socket.addEventListener("open", () => {
    rawSend({
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
        setupComplete?: unknown;
        serverContent?: {
          inputTranscription?: { text?: string };
          turnComplete?: boolean;
        };
      };
      if (!ready && message.setupComplete !== undefined) {
        ready = true;
        callbacks.onReady?.();
      }
      const text = message.serverContent?.inputTranscription?.text;
      if (text?.trim()) callbacks.onTranscript(text.trim());
      if (message.serverContent?.turnComplete) callbacks.onFinal?.();
    } catch {
      // Ignore malformed provider frames; the session stays usable.
    }
  });

  socket.addEventListener("error", () => {
    callbacks.onError("The live transcription provider could not be reached.");
  });

  socket.addEventListener("close", () => {
    closed = true;
    ready = false;
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
      ready = false;
      socket.close();
    },
    get closed() {
      return closed;
    },
    get ready() {
      return ready;
    },
  };
}
