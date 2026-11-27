import { Room, Track } from "livekit-client";

/**
 * LiveKit local microphone helpers shared by the interview room and the voice
 * generation room (TT-8 review fix — these were duplicated verbatim).
 *
 * MDN: `MediaStreamTrack.enabled` is the actual mute switch — setting it to
 * false makes the track emit silence. LiveKit's `setMicrophoneEnabled` controls
 * publishing; we also flip the browser track so "mute" is real user media.
 */
type LocalMicPublication = { audioTrack?: { mediaTrack?: MediaStreamTrack } };

/** Flips the underlying browser track's enabled flag to match the requested mute state. */
export function setBrowserMicEnabled(room: Room | null, enabled: boolean): void {
  const publication = room?.localParticipant.getTrackPublication(Track.Source.Microphone) as
    | LocalMicPublication
    | undefined;
  const track = publication?.audioTrack?.mediaTrack;
  if (track) track.enabled = enabled;
}
