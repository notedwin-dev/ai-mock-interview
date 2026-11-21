"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, MicOff } from "lucide-react";
import { Room, RoomEvent, Track, type RemoteParticipant } from "livekit-client";
import { EndInterviewButton } from "@/components/interview/EndInterviewButton";
import { readDevicePreferences } from "@/lib/interview/device-preferences";

/**
 * LiveKit WebRTC room (owner direction 2026-11-20). The invitation token is
 * exchanged server-side for a room-scoped participant credential; only the
 * microphone is published — camera remains a local-only preview (ADR-005).
 *
 * Device and mute choices made in the waiting room are applied here, and the
 * room state follows the real connection lifecycle (reconnecting, disconnected,
 * remote track unsubscribed) instead of assuming a permanent connection.
 */
type RoomStatus = "idle" | "connecting" | "connected" | "reconnecting";

export function WebRTCRoom({ token }: { token: string }) {
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLDivElement | null>(null);
  const leavingRef = useRef(false);
  const [status, setStatus] = useState<RoomStatus>("idle");
  const [participants, setParticipants] = useState<string[]>([]);
  const [muted, setMuted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => () => {
    leavingRef.current = true;
    void roomRef.current?.disconnect();
    roomRef.current = null;
  }, []);

  function refreshParticipants(room: Room) {
    setParticipants([...room.remoteParticipants.values()].map((p: RemoteParticipant) => p.identity));
  }

  function clearAudio() {
    audioRef.current?.replaceChildren();
  }

  async function join() {
    setError(null);
    setNotice(null);
    setStatus("connecting");
    leavingRef.current = false;
    const preferences = readDevicePreferences();
    // Output switching needs setSinkId; browsers without it keep the system
    // default instead of failing the join.
    const supportsOutputSelection =
      typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
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

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: preferences.micId ? { deviceId: preferences.micId } : undefined,
        audioOutput:
          preferences.speakerId && supportsOutputSelection
            ? { deviceId: preferences.speakerId }
            : undefined,
      });
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
      // A remote track that goes away must take its element with it, otherwise a
      // silent element keeps playing stale audio after a re-subscribe.
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((element) => element.remove());
      });
      room.on(RoomEvent.Reconnecting, () => setStatus("reconnecting"));
      room.on(RoomEvent.Reconnected, () => {
        setStatus("connected");
        setNotice(null);
        refreshParticipants(room);
      });
      room.on(RoomEvent.Disconnected, () => {
        clearAudio();
        setParticipants([]);
        setStatus("idle");
        if (!leavingRef.current) {
          setNotice("The live room disconnected. Rejoin to continue the interview.");
        }
      });

      await room.connect(body.url, body.token);
      try {
        if (!preferences.muted) {
          await room.localParticipant.setMicrophoneEnabled(true);
        }
      } catch {
        // A browser without microphone permission can still listen; the mic
        // state must reflect reality, so the control starts muted.
        setMuted(true);
        setNotice("Microphone unavailable — you can listen to the interviewer.");
      }
      if (preferences.muted) setMuted(true);
      refreshParticipants(room);
      setStatus("connected");
    } catch {
      setError("The live room could not be reached.");
      setStatus("idle");
    }
  }

  async function leave() {
    leavingRef.current = true;
    await roomRef.current?.disconnect();
    roomRef.current = null;
    clearAudio();
    setParticipants([]);
    setStatus("idle");
  }

  async function toggleMute() {
    const participant = roomRef.current?.localParticipant;
    if (!participant) return;
    const next = !muted;
    try {
      await participant.setMicrophoneEnabled(!next);
      setMuted(next);
    } catch {
      setMuted(true);
      setNotice("Microphone unavailable — you can listen to the interviewer.");
    }
  }

  if (ended) {
    return (
      <section aria-label="WebRTC interview room" className="flex flex-col gap-3 rounded-2xl border border-emerald-400/40 bg-surface p-5 text-sm text-ink">
        The interview has ended. Your transcript has been saved.
      </section>
    );
  }

  return (
    <section aria-label="WebRTC interview room" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">WebRTC room</h2>
          <p className="text-xs text-ink-muted">
            {status === "connected"
              ? `Connected · ${participants.length} other participant(s)`
              : status === "connecting" ? "Connecting…"
                : status === "reconnecting" ? "Reconnecting…" : "LiveKit audio session, not joined"}
          </p>
        </div>
        {status === "connected" || status === "reconnecting" ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void toggleMute()}
              aria-pressed={muted}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-line px-4 text-sm text-ink-soft"
            >
              {muted ? <MicOff className="h-4 w-4" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
              {muted ? "Unmute" : "Mute"}
            </button>
            <EndInterviewButton
              token={token}
              onEnded={() => {
                setEnded(true);
                void leave();
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void join()}
            disabled={status === "connecting"}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-emerald-400 px-5 text-sm font-semibold text-emerald-950 disabled:opacity-60"
          >
            {status === "connecting" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Join WebRTC call
          </button>
        )}
      </div>
      <div ref={audioRef} aria-hidden />
      {participants.length > 0 ? (
        <p className="text-xs text-ink-muted">
          {participants.length === 1
            ? "Interviewer connected"
            : `${participants.length} other participants connected`}
        </p>
      ) : null}
      {notice ? <p className="text-xs text-amber-300" role="status">{notice}</p> : null}
      {error ? <p className="text-xs text-red-400" role="alert">{error}</p> : null}
    </section>
  );
}
