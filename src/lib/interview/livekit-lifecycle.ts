import type { RoomStore } from "./room";

export type RoomLifecycleEvent = "room_started" | "room_finished";

/**
 * LiveKit webhooks are the single owner of the interview lifecycle for the
 * WebRTC runtime. The transition is idempotent: duplicate deliveries never
 * rewrite a status that has already moved on.
 */
export async function applyRoomLifecycle(
  event: RoomLifecycleEvent,
  sessionStatus: string,
  sessionId: string,
  store: Pick<RoomStore, "activate" | "complete">,
): Promise<void> {
  if (event === "room_started" && sessionStatus === "scheduled") {
    await store.activate(sessionId);
  } else if (event === "room_finished" && sessionStatus === "active") {
    await store.complete(sessionId);
  }
}
