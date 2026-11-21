import { z } from "zod";
import { WebhookReceiver } from "livekit-server-sdk";
import { jsonError } from "@/lib/api/respond";
import { db } from "@/lib/db";
import { getLiveKitConfig } from "@/lib/livekit/env";
import { applyRoomLifecycle } from "@/lib/interview/livekit-lifecycle";
import { createDefaultRoomStore } from "@/lib/interview/room-store";

/**
 * POST /api/v1/webhooks/livekit — owns the interview lifecycle for the
 * LiveKit WebRTC runtime (owner decision 2026-11-21). LiveKit sends
 * `room_started` and `room_finished`; the room name is the interview session
 * id (see webrtc/token route), so the event can be scoped to exactly one
 * session. Verification uses the documented WebhookReceiver with the raw body
 * and Authorization header — never a parsed object (LiveKit docs).
 */
const lifecycleEventSchema = z.object({
  event: z.enum(["room_started", "room_finished"]),
  room: z.object({ name: z.string().uuid() }),
});

export async function POST(request: Request): Promise<Response> {
  let config;
  try {
    config = getLiveKitConfig();
  } catch {
    return jsonError(409, "webrtc_not_configured", "LiveKit is not configured.");
  }

  const body = await request.text();
  const authorization = request.headers.get("authorization");
  if (!authorization) return jsonError(401, "unauthorized", "Missing webhook signature.");

  let event: unknown;
  try {
    event = await new WebhookReceiver(config.apiKey, config.apiSecret).receive(body, authorization);
  } catch {
    return jsonError(401, "invalid_signature", "The webhook signature was rejected.");
  }

  const parsed = lifecycleEventSchema.safeParse(event);
  if (!parsed.success) {
    // Other LiveKit events are valid but irrelevant to the interview lifecycle.
    return new Response(null, { status: 204 });
  }

  try {
    const { event: kind, room } = parsed.data;
    const session = await db.interviewSession.findUnique({
      where: { sessionId: room.name },
      select: { status: true },
    });
    if (!session) return new Response(null, { status: 204 });

    await applyRoomLifecycle(kind, session.status, room.name, createDefaultRoomStore());
    return new Response(null, { status: 204 });
  } catch {
    return jsonError(500, "internal_error", "The webhook could not be processed.");
  }
}
