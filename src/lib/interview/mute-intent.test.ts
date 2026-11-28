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
