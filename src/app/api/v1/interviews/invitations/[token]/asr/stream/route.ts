import { jsonError } from "@/lib/api/respond";
import {
  openLiveTranscription,
  type LiveTranscriptionSession,
} from "@/lib/ai/live-transcribe";
import { createDefaultRoomStore } from "@/lib/interview/room-store";
import { resolveForOutboundCall } from "@/lib/providers/config";

/**
 * Streaming ASR bridge for Google's `gemini-3.5-transcribe-live`.
 *
 * GET  -> SSE stream of incremental transcripts (`data: {"text":...}`).
 * POST -> relay a base64 16 kHz PCM audio window into that session.
 * DELETE -> signal end of speech and close the session.
 *
 * The browser never holds the provider key; it lives only in this module's
 * session map for the lifetime of one stream.
 */
interface StreamSession {
  session: LiveTranscriptionSession;
  push: (value: string) => void;
  createdAt: number;
}
const streams = new Map<string, StreamSession>();
const MAX_AGE_MS = 10 * 60 * 1000;

function reap() {
  const now = Date.now();
  for (const [id, entry] of streams) {
    if (now - entry.createdAt > MAX_AGE_MS || entry.session.closed) {
      entry.session.close();
      streams.delete(id);
    }
  }
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

    const id = crypto.randomUUID();
    const encoder = new TextEncoder();
    let push: (value: string) => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (value: string) => {
          try { controller.enqueue(encoder.encode(value)); } catch { /* already closed */ }
        };
        push(`data: ${JSON.stringify({ type: "ready", streamId: id })}\n\n`);
        const session = openLiveTranscription(
          {
            providerName: resolved.providerName,
            providerType: resolved.providerType,
            baseUrl: resolved.baseUrl,
            modelId: resolved.modelId,
            apiKey: resolved.apiKey,
          },
          {
            onTranscript: (text) => push(`data: ${JSON.stringify({ type: "transcript", text })}\n\n`),
            onError: (message) => push(`data: ${JSON.stringify({ type: "error", message })}\n\n`),
            onClose: () => push(`data: ${JSON.stringify({ type: "close" })}\n\n`),
          },
        );
        streams.set(id, { session, push, createdAt: Date.now() });
      },
      cancel() {
        const entry = streams.get(id);
        entry?.session.close();
        streams.delete(id);
      },
    });
    request.signal.addEventListener("abort", () => {
      const entry = streams.get(id);
      entry?.session.close();
      streams.delete(id);
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
  try {
    const { token } = await ctx.params;
    if (!(await resolveToken(token))) return jsonError(404, "invitation_not_found", "This interview link is not available.");
    const body = (await request.json().catch(() => null)) as { streamId?: string; audioBase64?: string } | null;
    const entry = body?.streamId ? streams.get(body.streamId) : undefined;
    if (!entry || !body?.audioBase64) return jsonError(400, "invalid_input", "Unknown stream or empty audio.");
    entry.session.sendAudio(body.audioBase64);
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
    if (!(await resolveToken(token))) return jsonError(404, "invitation_not_found", "This interview link is not available.");
    const url = new URL(request.url);
    const entry = streams.get(url.searchParams.get("streamId") ?? "");
    if (entry) {
      entry.session.endAudioStream();
      entry.session.close();
      streams.delete(url.searchParams.get("streamId")!);
    }
    return Response.json({ ok: true });
  } catch {
    return jsonError(500, "internal_error", "Something went wrong. Try again.");
  }
}
