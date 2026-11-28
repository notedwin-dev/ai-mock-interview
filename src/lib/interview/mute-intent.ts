/**
 * Race-safe microphone mute reconciliation for the LiveKit rooms.
 *
 * `setMicrophoneEnabled` is asynchronous: a mute toggle can land while that
 * call is pending. Applying a captured intent after the await would publish
 * audio for a candidate who just muted (or keep a track muted after Unmute).
 * These helpers re-read the live intent after each async boundary and converge
 * before any UI state is written. They are pure enough to unit-test without a
 * DOM, which is why the rooms delegate to them.
 */

export interface MuteCapableParticipant {
  isMicrophoneEnabled: boolean;
  // LiveKit returns a publication (or undefined), not void.
  setMicrophoneEnabled(enabled: boolean): Promise<unknown>;
}

/**
 * Drive the participant to the latest mute intent, re-reading it after every
 * await. Returns false when LiveKit rejects the publication (unavailable mic).
 */
export async function applyLatestMuteIntent(
  participant: MuteCapableParticipant,
  readIntent: () => boolean,
): Promise<boolean> {
  try {
    // The participant's current state is already "applied": no write is
    // needed when it matches the first intent read.
    let applied: boolean | null = participant.isMicrophoneEnabled;
    while (true) {
      const desired = !readIntent();
      if (applied === desired && participant.isMicrophoneEnabled === desired) return true;
      applied = desired;
      await participant.setMicrophoneEnabled(desired);
    }
  } catch {
    return false;
  }
}

/** Browser track state after a getUserMedia request resolves. */
export function acquisitionTrackEnabled(readIntent: () => boolean): boolean {
  return !readIntent();
}
