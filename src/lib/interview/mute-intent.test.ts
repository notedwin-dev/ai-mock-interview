import { describe, expect, it } from "vitest";
import { acquisitionTrackEnabled, applyLatestMuteIntent } from "./mute-intent";

/** Participant stand-in whose own state updates like LiveKit's does. */
function participant(initial = false, onSet?: () => void) {
  return {
    isMicrophoneEnabled: initial,
    async setMicrophoneEnabled(enabled: boolean) {
      this.isMicrophoneEnabled = enabled;
      onSet?.();
    },
  };
}

describe("applyLatestMuteIntent", () => {
  it("does not publish when the candidate is already muted", async () => {
    const calls: boolean[] = [];
    const room = participant(false, () => calls.push(room.isMicrophoneEnabled));
    expect(await applyLatestMuteIntent(room, () => true)).toBe(true);
    expect(calls).toEqual([]);
    expect(room.isMicrophoneEnabled).toBe(false);
  });

  it("publishes for an unmuted candidate", async () => {
    const room = participant(false);
    expect(await applyLatestMuteIntent(room, () => false)).toBe(true);
    expect(room.isMicrophoneEnabled).toBe(true);
  });

  it("applies a mute change that lands while publication is pending", async () => {
    let muted = false;
    const room = participant(false, () => {
      muted = true; // a newer Mute click while the first call is in flight
    });
    expect(await applyLatestMuteIntent(room, () => muted)).toBe(true);
    expect(room.isMicrophoneEnabled).toBe(false);
  });

  it("converges on the newest intent across rapid toggles", async () => {
    let muted = false;
    let flips = 2;
    const room = participant(false, () => {
      // Two toggles land during the first two awaits, then intent settles.
      if (flips > 0) {
        flips -= 1;
        muted = !muted;
      }
    });
    expect(await applyLatestMuteIntent(room, () => muted)).toBe(true);
    expect(muted).toBe(false);
    expect(room.isMicrophoneEnabled).toBe(true);
  });

  it("handles overlapping Unmute and Mute calls with deferred setters", async () => {
    let muted = false;
    const pending: Array<{ enabled: boolean; settle: () => void }> = [];
    const room = {
      isMicrophoneEnabled: false,
      setMicrophoneEnabled(enabled: boolean) {
        return new Promise<unknown>((resolve) => {
          pending.push({
            enabled,
            settle: () => {
              room.isMicrophoneEnabled = enabled;
              resolve(undefined);
            },
          });
        });
      },
    };

    // Start Unmute; its setter is still pending when Mute is requested.
    const unmute = applyLatestMuteIntent(room, () => muted);
    expect(pending.map((call) => call.enabled)).toEqual([true]);
    muted = true;
    const mute = applyLatestMuteIntent(room, () => muted);
    // Mute needs no write: the track is not published yet.
    expect(await mute).toBe(true);

    // Completing the older Unmute publication must not leave audio flowing.
    pending.shift()!.settle();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(pending.map((call) => call.enabled)).toEqual([false]);
    pending.shift()!.settle();

    expect(await unmute).toBe(true);
    expect(room.isMicrophoneEnabled).toBe(false);
  });

  it("reports an unavailable microphone without throwing", async () => {
    const room = {
      isMicrophoneEnabled: false,
      async setMicrophoneEnabled() {
        throw new Error("permission denied");
      },
    };
    expect(await applyLatestMuteIntent(room, () => false)).toBe(false);
  });
});

describe("acquisitionTrackEnabled", () => {
  it("reads the mute intent after acquisition instead of a captured value", () => {
    let muted = false;
    expect(acquisitionTrackEnabled(() => muted)).toBe(true);
    muted = true; // Mute clicked while getUserMedia was pending
    expect(acquisitionTrackEnabled(() => muted)).toBe(false);
  });
});
