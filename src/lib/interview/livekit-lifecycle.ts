import type { RoomStore } from "./room";

export type RoomLifecycleEvent = "room_started" | "room_finished";

/**
 * LiveKit webhooks own completion for the WebRTC runtime (the join route may
 * activate a scheduled session early so the End control works immediately).
 * The transition is idempotent: duplicate deliveries never rewrite a status
 * that has already moved on.
 */
export async function applyRoomLifecycle(
  event: RoomLifecycleEvent,
  sessionStatus: string,
  sessionId: string,
  store: Pick<RoomStore, "activate" | "complete">,
): Promise<void> {
  if (event === "room_started") {
    if (sessionStatus === "scheduled") await store.activate(sessionId);
    return;
  }
  if (event === "room_finished") {
    // A fast create/destroy can deliver room_finished without room_started.
    // Complete from either state, activating first so startedAt is set (the
    // DB requires completed_at to imply started_at).
    if (sessionStatus === "scheduled") await store.activate(sessionId);
    if (sessionStatus === "scheduled" || sessionStatus === "active") {
      await store.complete(sessionId);
    }
  }
}
