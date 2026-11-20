"use client";

import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, type RemoteParticipant } from "livekit-client";

/**
 * LiveKit WebRTC room (owner direction 2026-11-20). The invitation token is
 * exchanged server-side for a room-scoped participant credential; only the
 * microphone is published — camera remains a local-only preview (ADR-005).
 */
export function WebRTCRoom({ token }: { token: string }) {
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"idle" | "connecting" | "connected">("idle");
  const [participants, setParticipants] = useState<string[]>([]);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => {
    void roomRef.current?.disconnect();
    roomRef.current = null;
  }, []);

  function refreshParticipants(room: Room) {
    setParticipants([...room.remoteParticipants.values()].map((p: RemoteParticipant) => p.identity));
  }

  async function join() {
    setError(null);
    setStatus("connecting");
    try {
      const response = await fetch(
        `/api/v1/interviews/invitations/${encodeURIComponent(token)}/webrtc/token`,
        { method: "POST" },
      );
      const body = (await response.json()) as {
        url?: string; token?: string; error?: { message: string };
      };
      if (!response.ok || !body.url || !body.token) {
        setError(body.error?.message ?? "The live room could not be opened.");
        setStatus("idle");
        return;
      }

      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      room.on(RoomEvent.ParticipantConnected, () => refreshParticipants(room));
      room.on(RoomEvent.ParticipantDisconnected, () => refreshParticipants(room));
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio && audioRef.current) {
          const element = track.attach();
          element.autoplay = true;
          audioRef.current.appendChild(element);
        }
      });
      await room.connect(body.url, body.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      refreshParticipants(room);
      setStatus("connected");
    } catch {
      setError("The live room could not be reached.");
      setStatus("idle");
    }
  }

  async function leave() {
    await roomRef.current?.disconnect();
    roomRef.current = null;
    audioRef.current?.replaceChildren();
    setParticipants([]);
    setStatus("idle");
  }

  async function toggleMute() {
    const participant = roomRef.current?.localParticipant;
    if (!participant) return;
    const next = !muted;
    await participant.setMicrophoneEnabled(!next);
    setMuted(next);
  }

  return (
    <section aria-label="WebRTC interview room" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">WebRTC room</h2>
          <p className="text-xs text-ink-muted">
            {status === "connected"
              ? `Connected · ${participants.length} other participant(s)`
              : status === "connecting" ? "Connecting…" : "LiveKit audio session, not joined"}
          </p>
        </div>
        {status === "connected" ? (
          <div className="flex gap-2">
            <button type="button" onClick={() => void toggleMute()} className="inline-flex h-10 items-center rounded-full border border-line px-4 text-sm text-ink-soft">
              {muted ? "Unmute" : "Mute"}
            </button>
            <button type="button" onClick={() => void leave()} className="inline-flex h-10 items-center rounded-full bg-emerald-400 px-5 text-sm font-semibold text-emerald-950">
              Leave
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void join()}
            disabled={status === "connecting"}
            className="inline-flex h-10 items-center rounded-full bg-emerald-400 px-5 text-sm font-semibold text-emerald-950 disabled:opacity-60"
          >
            Join WebRTC call
          </button>
        )}
      </div>
      <div ref={audioRef} aria-hidden />
      {participants.length > 0 ? (
        <ul className="text-xs text-ink-muted">
          {participants.map((identity) => <li key={identity}>{identity}</li>)}
        </ul>
      ) : null}
      {error ? <p className="text-xs text-red-400" role="alert">{error}</p> : null}
    </section>
  );
}
