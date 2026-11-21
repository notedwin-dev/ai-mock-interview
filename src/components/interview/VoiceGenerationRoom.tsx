"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Mic, MicOff, PhoneOff, RotateCcw } from "lucide-react";
import { Room, RoomEvent, Track } from "livekit-client";

/**
 * Voice-driven interview generation (FR-SETUP-006). The same two-panel shape
 * as the live room, but the conversation plans the interview instead of
 * running it. Powered by the free Gemini Live + LiveKit stack already in use.
 */
type Status = "starting" | "connecting" | "connected" | "reconnecting" | "completed" | "error";

// One generation per page load, even across React Strict Mode's double-invoked
// effects in development. A ref would be reset by the remount; a module flag is
// the reliable one-shot guard here.
let generationStartedThisLoad = false;

interface GenerationState {
  id: string;
  status: string;
  caption: { speaker: "agent" | "candidate"; text: string } | null;
  invitationPath: string | null;
}

export function VoiceGenerationRoom() {
  const router = useRouter();
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<Status>("starting");
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [generation, setGeneration] = useState<GenerationState | null>(null);
  const [muted, setMuted] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (generationStartedThisLoad) return;
    generationStartedThisLoad = true;
    const active = true;
    roomRef.current = null;

    async function start() {
      try {
        const response = await fetch("/api/v1/interviews/generation", { method: "POST" });
        const body = (await response.json().catch(() => null)) as
          | { id?: string; url?: string; token?: string; error?: { message?: string } }
          | null;
        if (!response.ok || !body?.id || !body?.url || !body?.token) {
          if (!active) return;
          setError(body?.error?.message ?? "Voice generation is not available right now.");
          setStatus("error");
          return;
        }
        const room = new Room({ adaptiveStream: true, dynacast: true });
        roomRef.current = room;
        room.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === Track.Kind.Audio) {
            const element = track.attach();
            audioRef.current?.appendChild(element);
          }
        });
        room.on(RoomEvent.TrackUnsubscribed, (track) => {
          track.detach().forEach((element) => element.remove());
        });
        room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          if (!active) return;
          setIsSpeaking(speakers.some((speaker) => speaker.identity !== room.localParticipant.identity));
        });
        room.on(RoomEvent.Reconnecting, () => { if (active) setStatus("reconnecting"); });
        room.on(RoomEvent.Reconnected, () => { if (active) setStatus("connected"); });
        room.on(RoomEvent.Disconnected, () => {
          if (active) setStatus((current) => (current === "completed" ? current : "error"));
        });
        if (active) {
          setGenerationId(body.id);
          setStatus("connecting");
        }
        await room.connect(body.url, body.token);
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
        } catch {
          if (active) {
            setMuted(true);
            setError("Microphone unavailable — the planner cannot hear you.");
          }
        }
        if (active) setStatus("connected");
      } catch {
        if (active) {
          setError("The voice generation room could not be reached.");
          setStatus("error");
        }
      }
    }
    queueMicrotask(() => void start());
  }, []);

  useEffect(() => {
    if (!generationId) return;
    let active = true;
    async function poll() {
      try {
        const response = await fetch(
          `/api/v1/interviews/generation/${encodeURIComponent(generationId!)}`,
          { cache: "no-store" },
        );
        if (!response.ok || !active) return;
        const data = (await response.json()) as GenerationState;
        if (!active) return;
        setGeneration(data);
        if (data.status === "completed" && data.invitationPath) {
          setStatus("completed");
          void roomRef.current?.disconnect();
          router.push(`${data.invitationPath}/waiting`);
        }
      } catch {
        // Transient poll failure: the next tick retries.
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [generationId, router]);

  async function toggleMute() {
    const participant = roomRef.current?.localParticipant;
    if (!participant) return;
    const next = !muted;
    try {
      await participant.setMicrophoneEnabled(!next);
      setMuted(!participant.isMicrophoneEnabled);
    } catch {
      setMuted(true);
    }
  }

  function repeatLast() {
    const text = generation?.caption?.text;
    if (!text || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  function leave() {
    void roomRef.current?.disconnect();
    router.push("/dashboard");
  }

  const caption = generation?.caption?.text ??
    "The planner will speak shortly. Tell it about the interview you want to practise.";

  return (
    <div className="flex min-h-[calc(100vh-2rem)] flex-col gap-4">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-5 py-3">
        <div>
          <h1 className="font-display text-lg font-semibold text-ink">Interview generation</h1>
          <p className="mt-1 text-xs text-ink-muted">
            {status === "connected" ? "Connected — tell the planner what you need."
              : status === "connecting" ? "Connecting…"
                : status === "reconnecting" ? "Reconnecting…"
                  : status === "completed" ? "Your interview is ready."
                    : status === "error" ? "Could not start the voice planner."
                      : "Starting the voice planner…"}
          </p>
        </div>
        <button type="button" onClick={leave} className="inline-flex h-10 items-center gap-2 rounded-full bg-red-500 px-5 text-sm font-semibold text-white">
          <PhoneOff className="h-4 w-4" aria-hidden /> Leave generation
        </button>
      </section>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
        <section aria-label="AI planner" className="flex min-h-[18rem] flex-col items-center justify-center rounded-3xl border border-line bg-surface p-8 text-center">
          <span
            aria-hidden
            className={`flex h-20 w-20 items-center justify-center rounded-full border text-2xl font-bold transition-colors ${isSpeaking ? "border-emerald-400 bg-emerald-400/15 text-emerald-300" : "border-line bg-raised text-ink-soft"}`}>
            AI
          </span>
          <h2 className="mt-4 text-sm font-semibold text-ink">AI Interviewer</h2>
          <p className="mt-1 text-xs text-ink-muted">{status === "connected" ? "Listening" : "Not connected"}</p>
        </section>
        <section aria-label="You" className="flex min-h-[18rem] flex-col items-center justify-center rounded-3xl border border-line bg-surface p-8 text-center">
          <span aria-hidden className="flex h-20 w-20 items-center justify-center rounded-full border border-line bg-raised text-2xl font-bold text-ink-soft">Y</span>
          <h2 className="mt-4 text-sm font-semibold text-ink">You</h2>
          <p className="mt-1 text-xs text-ink-muted">{muted ? "Microphone muted" : "Microphone ready"}</p>
          <button type="button" onClick={() => void toggleMute()} aria-label="Microphone" aria-pressed={muted} className="mt-4 inline-flex h-10 items-center gap-2 rounded-full border border-line px-4 text-sm text-ink-soft">
            {muted ? <MicOff className="h-4 w-4" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
            {muted ? "Unmute" : "Mute"}
          </button>
        </section>
      </div>

      <div className="rounded-2xl border border-line bg-surface px-5 py-4 text-center text-sm text-ink-soft" aria-live="polite">
        {caption}
      </div>
      <div className="flex justify-center gap-2">
        <button type="button" onClick={repeatLast} className="inline-flex h-10 items-center gap-2 rounded-full border border-line px-5 text-sm text-ink-soft">
          {status === "starting" || status === "connecting" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}
          Repeat
        </button>
      </div>
      <div ref={audioRef} aria-hidden />
      {error ? <p className="text-sm text-red-400" role="alert">{error}</p> : null}
    </div>
  );
}
