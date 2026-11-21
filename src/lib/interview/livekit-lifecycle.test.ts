import { describe, expect, it, vi } from "vitest";
import { applyRoomLifecycle } from "./livekit-lifecycle";

function fakeStore() {
  return { activate: vi.fn(async () => {}), complete: vi.fn(async () => {}) };
}

describe("LiveKit room lifecycle webhooks", () => {
  it("activates a scheduled session when the room starts", async () => {
    const store = fakeStore();
    await applyRoomLifecycle("room_started", "scheduled", "session-1", store);
    expect(store.activate).toHaveBeenCalledWith("session-1");
    expect(store.complete).not.toHaveBeenCalled();
  });

  it("completes an active session when the room finishes", async () => {
    const store = fakeStore();
    await applyRoomLifecycle("room_finished", "active", "session-1", store);
    expect(store.complete).toHaveBeenCalledWith("session-1");
    expect(store.activate).not.toHaveBeenCalled();
  });

  it("completes a scheduled session on an early room_finished", async () => {
    const store = fakeStore();
    await applyRoomLifecycle("room_finished", "scheduled", "session-1", store);
    expect(store.activate).toHaveBeenCalledWith("session-1");
    expect(store.complete).toHaveBeenCalledWith("session-1");
  });

  it("ignores duplicate or out-of-order deliveries", async () => {
    const store = fakeStore();
    await applyRoomLifecycle("room_started", "active", "session-1", store);
    await applyRoomLifecycle("room_finished", "completed", "session-1", store);
    expect(store.activate).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });
});
