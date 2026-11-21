"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageSquare, X } from "lucide-react";
import { Room, RoomEvent, Track, type RemoteParticipant } from "livekit-client";
import { EndInterviewButton } from "@/components/interview/EndInterviewButton";
import { VoiceRoomPanels } from "@/components/interview/VoiceRoomPanels";
import { readDevicePreferences, saveDevicePreferences } from "@/lib/interview/device-preferences";
import { CAPTION_TOPIC } from "@/lib/interview/generation-contract.mjs";
import type { TranscriptEntry } from "@/lib/interview/room";

/**
 * LiveKit WebRTC interview room (owner direction 2026-11-20). The invitation
 * token is exchanged server-side for a room-scoped participant credential;
 * only the microphone is published — the camera is never an AI input.
 *
 * The call transport is LiveKit; this component is the candidate's ONE room UI:
 * two participant panels, AI states and an independently openable live
 * conversation overlay backed by the token-scoped transcript (ADR-006).
 */
type RoomStatus = "idle" | "connecting" | "connected" | "reconnecting";

const GHOST =
  "inline-flex h-10 items-center gap-2 rounded-full border border-line px-4 text-sm text-ink-soft outline-none transition-colors hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-emerald-400";

export function WebRTCRoom({
  token,
  sessionId,
  autoJoin = false,
}: {
  token: string;
  sessionId: string;
  autoJoin?: boolean;
}) {
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const leavingRef = useRef(false);
  const didAutoJoinRef = useRef(false);
  const [status, setStatus] = useState<RoomStatus>("idle");
  const [joined, setJoined] = useState(false);
  const [participants, setParticipants] = useState<string[]>([]);
  const [muted, setMuted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [messages, setMessages] = useState<TranscriptEntry[]>([]);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [caption, setCaption] = useState("The interviewer will speak shortly.");
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);

  useEffect(() => () => {
    leavingRef.current = true;
    void roomRef.current?.disconnect();
    roomRef.current = null;
  }, []);

  const loadTranscript = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/v1/interviews/invitations/${encodeURIComponent(token)}/turns`,
        { cache: "no-store" },
      );
      if (response.ok) {
        const body = (await response.json()) as { messages: TranscriptEntry[] };
        setMessages(body.messages ?? []);
      }
    } catch {
      // The next poll retries; the call itself is unaffected.
    }
  }, [token]);

  useEffect(() => {
    const timer = setInterval(() => void loadTranscript(), 4000);
    // Prime once off the effect body so React does not flag a cascading render.
    const prime = setTimeout(() => void loadTranscript(), 0);
    return () => {
      clearInterval(timer);
      clearTimeout(prime);
    };
  }, [loadTranscript]);

  /** Overlay dialog: focus in, Escape to close, focus back to the opener. */
  useEffect(() => {
    if (!overlayOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlayRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOverlayOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = overlayRef.current?.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [overlayOpen]);

  const refreshParticipants = useCallback((room: Room) => {
    setParticipants([...room.remoteParticipants.values()].map((p: RemoteParticipant) => p.identity));
  }, []);

  function clearAudio() {
    audioRef.current?.replaceChildren();
  }

  const join = useCallback(async () => {
    setError(null);
    setNotice(null);
    setStatus("connecting");
    leavingRef.current = false;
    const preferences = readDevicePreferences();
    // Never carry a stale mute state across a rejoin. The stored preference is
    // the source of truth until the real track state is read back below.
    setMuted(preferences.muted);
    const supportsOutputSelection =
      typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
    try {
      const response = await fetch(
        `/api/v1/interviews/invitations/${encodeURIComponent(token)}/webrtc/token`,
        { method: "POST" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "The live room could not be created.");
        setStatus("idle");
        return;
      }
      const body = (await response.json()) as { url: string; token: string };
      // The token route has already activated the session; expose End even if
      // the LiveKit connection itself cannot be established.
      setJoined(true);

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
        if (track.kind === Track.Kind.Audio) {
          const element = track.attach();
          audioRef.current?.appendChild(element);
        }
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((element) => element.remove());
      });
      room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
        if (topic !== CAPTION_TOPIC) return;
        try {
          const parsed = JSON.parse(new TextDecoder().decode(payload)) as { text?: string };
          if (parsed.text) setCaption(parsed.text);
        } catch {
          // Ignore malformed caption packets.
        }
      });
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const local = room.localParticipant.identity;
        setIsAgentSpeaking(speakers.some((speaker) => speaker.identity !== local));
        setIsUserSpeaking(speakers.some((speaker) => speaker.identity === local));
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
      let micUnavailable = false;
      try {
        if (!preferences.muted) {
          await room.localParticipant.setMicrophoneEnabled(true);
        }
      } catch {
        micUnavailable = true;
      }
      // Reflect the actual track state, not the requested state — a permission
      // denial or a rejoin must never show "muted" while audio is being sent.
      setMuted(micUnavailable || !room.localParticipant.isMicrophoneEnabled);
      if (micUnavailable) {
        setNotice("Microphone unavailable — you can listen to the interviewer.");
      }
      refreshParticipants(room);
      setStatus("connected");
      void loadTranscript();
    } catch {
      setError("The live room could not be reached. Check the server configuration.");
      setStatus("idle");
    }
  }, [token, loadTranscript, refreshParticipants]);

  // "Join now" in the waiting room is the single join action: connect
  // immediately on arrival, without asking the candidate to click again.
  useEffect(() => {
    if (!autoJoin || didAutoJoinRef.current) return;
    didAutoJoinRef.current = true;
    // Drop the one-shot flag from the URL before connecting.
    window.history.replaceState(null, "", `/interview/${token}/room`);
    // A microtask cannot be cancelled by the route-transition cleanup that
    // previously swallowed the deferred join.
    queueMicrotask(() => void join());
  }, [autoJoin, token, join]);

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
    const next = !muted;
    if (!participant) {
      setMuted(next);
      saveMutePreference(next);
      return;
    }
    try {
      await participant.setMicrophoneEnabled(!next);
      const actual = !participant.isMicrophoneEnabled;
      setMuted(actual);
      saveMutePreference(actual);
    } catch {
      setMuted(true);
      saveMutePreference(true);
      setNotice("Microphone unavailable — you can listen to the interviewer.");
    }
  }

  function saveMutePreference(nextMuted: boolean) {
    const current = readDevicePreferences();
    saveDevicePreferences({ ...current, muted: nextMuted });
  }

  const aiState =
    status === "connected" || status === "reconnecting"
      ? participants.length > 0
        ? "Interviewer connected — listening"
        : "Waiting for the interviewer"
      : "Not connected";

  if (ended) {
    return (
      <section aria-label="Interview room" className="flex flex-col gap-3 rounded-2xl border border-emerald-400/40 bg-surface p-5 text-sm text-ink">
        The interview has ended. Your transcript has been saved.
      </section>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-2rem)] flex-col gap-4">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-5 py-3">
        <div>
          <h1 className="font-display text-lg font-semibold text-ink">Live interview room</h1>
          <p className="mt-1 text-xs text-ink-muted">
            {status === "connected"
              ? `Connected · ${participants.length} other participant(s)`
              : status === "connecting"
                ? "Connecting…"
                : status === "reconnecting"
                  ? "Reconnecting…"
                  : "LiveKit audio session, not joined"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setOverlayOpen((open) => !open)} className={GHOST}>
            {overlayOpen ? <X className="h-4 w-4" aria-hidden /> : <MessageSquare className="h-4 w-4" aria-hidden />}
            {overlayOpen ? "Hide conversation" : "Open conversation"}
          </button>
          {joined ? (
            <div className="flex flex-wrap items-center gap-2">
              {status === "idle" ? (
                <button
                  type="button"
                  onClick={() => void join()}
                  className="inline-flex h-10 items-center gap-2 rounded-full border border-line px-5 text-sm font-semibold text-ink-soft"
                >
                  Rejoin call
                </button>
              ) : null}
              <EndInterviewButton
                token={token}
                feedbackHref={`/dashboard/interview/${sessionId}/feedback`}
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
      </section>

      <VoiceRoomPanels
        isAgentSpeaking={isAgentSpeaking}
        isUserSpeaking={isUserSpeaking}
        muted={muted}
        caption={caption}
        onToggleMute={() => void toggleMute()}
        agentState={aiState}
      />

      <div ref={audioRef} aria-hidden />
      {notice ? <p className="text-xs text-amber-300" role="status">{notice}</p> : null}
      {error ? <p className="text-sm text-red-400" role="alert">{error}</p> : null}

      {overlayOpen ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60" role="dialog" aria-modal="true" aria-labelledby="conversation-heading">
          <button type="button" aria-label="Close conversation" onClick={() => setOverlayOpen(false)} className="absolute inset-0 cursor-default" />
          <div ref={overlayRef} tabIndex={-1} className="relative z-10 flex h-full w-full max-w-md flex-col gap-3 overflow-y-auto border-l border-line bg-surface p-5 outline-none">
            <div className="flex items-center justify-between">
              <h2 id="conversation-heading" className="font-display text-lg font-semibold text-ink">Conversation</h2>
              <button type="button" onClick={() => setOverlayOpen(false)} className={GHOST}>Close</button>
            </div>
            {messages.length === 0 ? (
              <p className="text-sm text-ink-muted">The conversation will appear here as it happens.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {messages.map((message) => (
                  <div key={message.sequenceNumber} className={`max-w-[90%] rounded-2xl px-4 py-2 text-sm ${message.speakerType === "candidate" ? "self-end bg-emerald-400/15 text-ink" : "self-start bg-raised text-ink-soft"}`}>
                    <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-ink-muted">
                      {message.speakerType === "candidate" ? "You" : "AI"}
                    </span>
                    {message.contentText}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
