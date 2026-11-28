import { jsonError } from "@/lib/api/respond";
import {
  isLiveTranscribeRoute,
  openLiveTranscription,
  type LiveTranscriptionSession,
} from "@/lib/ai/live-transcribe";
import { createDefaultRoomStore } from "@/lib/interview/room-store";
import { resolveForOutboundCall } from "@/lib/providers/config";
import { z } from "zod";

/**
 * Streaming ASR bridge for Google's `gemini-3.5-transcribe-live`.
 *
 * GET  -> SSE stream of incremental transcripts (`data: {"text":...}`).
 * POST -> relay a base64 16 kHz PCM audio window into that session.
 * DELETE -> signal end of speech and close the session.
 *
 * The browser never holds the provider key; it lives only in this module's
 * session map for the lifetime of one stream. Session ownership, admission,
 * readiness, ordering and teardown are all enforced here at the server edge.
 */
interface StreamSession {
  id: string;
  session: LiveTranscriptionSession;
  /** Interview that owns the invitation used to open this bridge. */
  sessionId: string;
  createdAt: number;
  push: (value: string) => void;
  closeSse: () => void;
  removeAbort: () => void;
  closeTimer?: ReturnType<typeof setTimeout>;
  endRequested: boolean;
  /** PCM windows keyed by server arrival order, drained ascending. */
  queued: Map<number, string>;
  drainInFlight: Promise<void> | null;
}

const streams = new Map<string, StreamSession>();
const MAX_AGE_MS = 10 * 60 * 1000;
/** Per-process bound; a stale stream may overlap one reconnect. */
const MAX_STREAMS_PER_INTERVIEW = 2;
const FINALIZE_TIMEOUT_MS = 2000;
const CLIENT_CLOSE_GRACE_MS = 5000;
const MAX_AUDIO_BASE64_CHARS = 128 * 1024;
let arrivalCounter = 0;

const audioPostSchema = z.object({
  streamId: z.uuid(),
  audioBase64: z
    .string()
    .min(4)
    .max(MAX_AUDIO_BASE64_CHARS)
    .refine(
      (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value),
      "Audio is not valid base64.",
    )
    .refine((value) => {
      try {
        // 16 kHz 16-bit mono PCM: decoded length must be an even byte count.
        return atob(value).length % 2 === 0;
      } catch {
        return false;
      }
    }, "Audio does not contain complete PCM samples."),
});

function clearCloseTimer(entry: StreamSession) {
  if (entry.closeTimer) {
    clearTimeout(entry.closeTimer);
    entry.closeTimer = undefined;
  }
}

/** One idempotent teardown path for every exit (close, error, cancel, abort, expiry). */
function cleanup(id: string) {
  const entry = streams.get(id);
  if (!entry) return;
  streams.delete(id);
  clearCloseTimer(entry);
  entry.removeAbort();
  entry.session.close();
  // Stop EventSource from silently opening a replacement bridge after a
  // terminal close; an hour is effectively "never" for the browser client.
  entry.push("retry: 3600000\n\n");
  entry.closeSse();
}

function reap() {
  const now = Date.now();
  for (const [id, entry] of streams) {
    if (now - entry.createdAt > MAX_AGE_MS || entry.session.closed) cleanup(id);
  }
}

/** Relay queued PCM in capture (arrival) order, even across overlapping POSTs. */
function drain(entry: StreamSession): Promise<void> {
  if (entry.drainInFlight) return entry.drainInFlight;
  const run = (async () => {
    while (entry.queued.size > 0) {
      const sequence = Math.min(...entry.queued.keys());
      const audio = entry.queued.get(sequence)!;
      entry.queued.delete(sequence);
      if (streams.get(entry.id) === entry) entry.session.sendAudio(audio);
    }
  })().finally(() => {
    if (entry.drainInFlight === run) entry.drainInFlight = null;
  });
  entry.drainInFlight = run;
  return run;
}

async function resolveToken(token: string) {
  const interview = await createDefaultRoomStore().context(token);
  if (!interview || (interview.status !== "scheduled" && interview.status !== "active")) return null;
  return interview;
}

export async function GET(
  request: Request,
  ctx: RouteContext<"/api/v1/interviews/invitations/[token]/asr/stream">,
): Promise<Response> {
  try {
    reap();
    const { token } = await ctx.params;
    const interview = await resolveToken(token);
    if (!interview) return jsonError(404, "invitation_not_found", "This interview link is not available.");
    let resolved;
    try {
      resolved = await resolveForOutboundCall(interview.userId, "asr");
    } catch {
      return jsonError(409, "voice_not_configured", "No speech-recognition provider is enabled.");
    }
    // The bridge always dials Google. Never hand a custom provider's key to it.
    if (!isLiveTranscribeRoute(resolved)) {
      return jsonError(
        409,
        "streaming_not_supported",
        "The configured speech-recognition provider does not support live transcription.",
      );
    }
    // Admission and insertion run without an intervening await, so concurrent
    // requests in this process cannot both pass the check.
    const active = [...streams.values()].filter(
      (entry) => entry.sessionId === interview.sessionId,
    ).length;
    if (active >= MAX_STREAMS_PER_INTERVIEW) {
      return jsonError(429, "stream_limit", "Too many live transcription streams are open.");
    }

    const id = crypto.randomUUID();
    const encoder = new TextEncoder();
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    let sseClosed = false;
    const closeSse = () => {
      if (sseClosed) return;
      sseClosed = true;
      try {
        controllerRef?.close();
      } catch {
        /* already closed */
      }
    };
    let push: (value: string) => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        push = (value: string) => {
          if (sseClosed) return;
          try {
            controller.enqueue(encoder.encode(value));
          } catch {
            /* already closed */
          }
        };
        const session = openLiveTranscription(
          {
            providerName: resolved.providerName,
            providerType: resolved.providerType,
            baseUrl: resolved.baseUrl,
            modelId: resolved.modelId,
            apiKey: resolved.apiKey,
          },
          {
            // Ready is only announced after Gemini's setupComplete, so the
            // first PCM window is never sent into an unready socket.
            onReady: () => push(`data: ${JSON.stringify({ type: "ready", streamId: id })}\n\n`),
            onTranscript: (text) => push(`data: ${JSON.stringify({ type: "transcript", text })}\n\n`),
            onFinal: () => {
              const entry = streams.get(id);
              if (entry?.endRequested) cleanup(id);
            },
            onError: (message) => {
              push(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
              cleanup(id);
            },
            onClose: () => cleanup(id),
          },
        );
        const onAbort = () => cleanup(id);
        streams.set(id, {
          id,
          session,
          sessionId: interview.sessionId,
          createdAt: Date.now(),
          push,
          closeSse,
          removeAbort: () => request.signal.removeEventListener("abort", onAbort),
          endRequested: false,
          queued: new Map(),
          drainInFlight: null,
        });
        request.signal.addEventListener("abort", onAbort, { once: true });
      },
      cancel() {
        const entry = streams.get(id);
        if (!entry) return;
        // A mic-off closes SSE before DELETE. Keep the provider session for a
        // bounded grace period so that DELETE can finalize the last utterance.
        clearCloseTimer(entry);
        entry.closeTimer = setTimeout(() => cleanup(id), CLIENT_CLOSE_GRACE_MS);
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  } catch {
    return jsonError(500, "internal_error", "Something went wrong. Try again.");
  }
}

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/v1/interviews/invitations/[token]/asr/stream">,
): Promise<Response> {
  // Captured synchronously before any await: this is the order the windows
  // arrived at the server, which is the order they must reach the provider.
  const sequence = ++arrivalCounter;
  try {
    const { token } = await ctx.params;
    const interview = await resolveToken(token);
    if (!interview) return jsonError(404, "invitation_not_found", "This interview link is not available.");
    const parsed = audioPostSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "invalid_input", "Invalid stream or audio payload.");
    const entry = streams.get(parsed.data.streamId);
    if (!entry || entry.sessionId !== interview.sessionId) {
      return jsonError(404, "invitation_not_found", "This interview link is not available.");
    }
    if (!entry.session.ready || entry.session.closed) {
      return jsonError(409, "stream_not_ready", "Live transcription is not ready.");
    }
    entry.queued.set(sequence, parsed.data.audioBase64);
    await drain(entry);
    return Response.json({ ok: true });
  } catch {
    return jsonError(500, "internal_error", "Something went wrong. Try again.");
  }
}

export async function DELETE(
  request: Request,
  ctx: RouteContext<"/api/v1/interviews/invitations/[token]/asr/stream">,
): Promise<Response> {
  try {
    const { token } = await ctx.params;
    const interview = await resolveToken(token);
    if (!interview) return jsonError(404, "invitation_not_found", "This interview link is not available.");
    const url = new URL(request.url);
    const entry = streams.get(url.searchParams.get("streamId") ?? "");
    if (!entry || entry.sessionId !== interview.sessionId) {
      return jsonError(404, "invitation_not_found", "This interview link is not available.");
    }
    // Stop capture first, then let the provider flush its final transcript.
    // onFinal closes immediately; the timer bounds a provider that never
    // reports completion. End/unmount use the same path, so no work outlives
    // the interview beyond this bounded window.
    entry.endRequested = true;
    entry.session.endAudioStream();
    clearCloseTimer(entry);
    entry.closeTimer = setTimeout(() => cleanup(entry.id), FINALIZE_TIMEOUT_MS);
    return Response.json({ ok: true });
  } catch {
    return jsonError(500, "internal_error", "Something went wrong. Try again.");
  }
}
