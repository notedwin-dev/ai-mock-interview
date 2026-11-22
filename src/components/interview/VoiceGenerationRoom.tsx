"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PhoneOff, RotateCcw } from "lucide-react";
import { Room, RoomEvent, Track } from "livekit-client";
import { GenerationConfirmation, type ConfirmableConfig } from "@/components/interview/GenerationConfirmation";
import { InterviewNextSteps } from "@/components/interview/InterviewNextSteps";
import { VoiceRoomPanels } from "@/components/interview/VoiceRoomPanels";
import { CAPTION_TOPIC } from "@/lib/interview/generation-contract.mjs";

/**
 * Voice-driven interview generation (FR-SETUP-006). The same two-panel shape
 * as the live room, but the conversation plans the interview instead of
 * running it. Powered by the free Gemini Live + LiveKit stack already in use.
 */
type Status = "starting" | "connecting" | "connected" | "reconnecting" | "completed" | "error";

// One generation per page load, including Strict Mode's double effect. Reset
// shortly after a real unmount so revisiting the page starts a fresh session.
let generationStartedThisLoad = false;

/** MDN: MediaStreamTrack.enabled is the real mute switch for captured audio. */
type LocalMicPublication = { audioTrack?: { mediaTrack?: MediaStreamTrack } };

function setBrowserMicEnabled(room: Room | null, enabled: boolean) {
  const publication = room?.localParticipant.getTrackPublication(Track.Source.Microphone) as
    | LocalMicPublication
    | undefined;
  const track = publication?.audioTrack?.mediaTrack;
  if (track) track.enabled = enabled;
}

interface GenerationConfig {
  jobRole: string;
  jobDescription: string;
  experienceLevel?: string;
  techStack?: string[];
  questionCount?: number;
  strictness: "supportive" | "balanced" | "rigorous";
  category: "general" | "technical" | "behavioral";
}

interface GenerationState {
  id: string;
  status: string;
  caption: { speaker: "agent" | "candidate"; text: string } | null;
  config: GenerationConfig | null;
  invitationPath: string | null;
}

export function VoiceGenerationRoom() {
  const router = useRouter();
  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLDivElement | null>(null);
  const startedAtRef = useRef(Date.now());
  const agentPresentRef = useRef(false);
  const [status, setStatus] = useState<Status>("starting");
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [generation, setGeneration] = useState<GenerationState | null>(null);
  const [confirmed, setConfirmed] = useState<{ invitationPath: string; sessionId: string } | null>(null);
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [liveCaption, setLiveCaption] = useState<{ speaker: "agent" | "candidate"; text: string } | null>(null);
  const [agentPresent, setAgentPresent] = useState(false);
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
        room.on(RoomEvent.ParticipantConnected, () => {
          agentPresentRef.current = true;
          if (active) setAgentPresent(true);
        });
        room.on(RoomEvent.ParticipantDisconnected, () => {
          agentPresentRef.current = false;
          if (active) setAgentPresent(false);
        });
        room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          if (!active) return;
          const local = room.localParticipant.identity;
          setIsAgentSpeaking(speakers.some((speaker) => speaker.identity !== local));
          setIsUserSpeaking(speakers.some((speaker) => speaker.identity === local));
        });
        room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
          if (!active || topic !== CAPTION_TOPIC) return;
          try {
            const parsed = JSON.parse(new TextDecoder().decode(payload)) as {
              speaker?: string;
              text?: string;
            };
            if (parsed.text && (parsed.speaker === "agent" || parsed.speaker === "candidate")) {
              setLiveCaption({ speaker: parsed.speaker, text: parsed.text });
            }
          } catch {
            // Ignore malformed data messages; they never affect the call.
          }
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
            mutedRef.current = true;
            setMuted(true);
            setError("Microphone unavailable — the planner cannot hear you.");
          }
        }
        setBrowserMicEnabled(room, !mutedRef.current);
        if (active) setStatus("connected");
      } catch {
        if (active) {
          setError("The voice generation room could not be reached.");
          setStatus("error");
        }
      }
    }
    queueMicrotask(() => void start());
    return () => {
      void roomRef.current?.disconnect();
      roomRef.current = null;
      // Strict Mode's immediate remount happens well within 250ms; a genuine
      // navigation then clears the guard for the next planning session.
      setTimeout(() => { generationStartedThisLoad = false; }, 250);
    };
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
        // Only bail out if the agent never joined at all. Once it is in the
        // room, captions may come via the data channel rather than this poll.
        if (
          data.status === "collecting" &&
          !agentPresentRef.current &&
          Date.now() - startedAtRef.current > 60000
        ) {
          setError("The planner did not join in time. Leave and start a new voice session.");
        }
        if (data.status === "completed" && data.invitationPath) {
          setStatus("completed");
          void roomRef.current?.disconnect();
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
    const next = !mutedRef.current;
    setBrowserMicEnabled(roomRef.current, !next);
    mutedRef.current = next;
    setMuted(next);
    if (!participant) return;
    try {
      await participant.setMicrophoneEnabled(!next);
    } catch {
      mutedRef.current = true;
      setMuted(true);
      setBrowserMicEnabled(roomRef.current, false);
    }
  }

  async function confirm(config: ConfirmableConfig) {
    if (!generationId) return;
    const response = await fetch(
      `/api/v1/interviews/generation/${encodeURIComponent(generationId)}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      },
    );
    const body = (await response.json().catch(() => null)) as
      | { invitationPath?: string; sessionId?: string; error?: { message?: string } }
      | null;
    if (!response.ok || !body?.invitationPath || !body?.sessionId) {
      throw new Error(body?.error?.message ?? "Could not confirm the interview.");
    }
    generationStartedThisLoad = false;
    // Confirming only applies the details. The candidate decides what happens
    // next: start now, schedule, or leave and set it later (owner decision).
    setConfirmed({ invitationPath: body.invitationPath, sessionId: body.sessionId });
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

  const caption = liveCaption?.text ?? generation?.caption?.text ??
    (status === "connected" && !agentPresent
      ? "Connected. Waiting for the planner to join…"
      : status === "connected"
        ? "The planner is ready. It will ask the first question shortly."
        : "The planner will speak shortly. Tell it about the interview you want to practise.");

  return (
    <div className="flex min-h-[calc(100vh-2rem)] flex-col gap-4">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-5 py-3">
        <div>
          <h1 className="font-display text-lg font-semibold text-ink">Interview generation</h1>
          <p className="mt-1 text-xs text-ink-muted">
            {status === "connected"
              ? agentPresent
                ? "Connected — answer the planner's questions."
                : "Connected — waiting for the planner to join."
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

      {confirmed ? (
        <InterviewNextSteps
          invitationPath={confirmed.invitationPath}
          sessionId={confirmed.sessionId}
        />
      ) : status === "completed" && generation?.config ? (
        <GenerationConfirmation config={generation.config} onConfirm={confirm} />
      ) : (
        <>
          <VoiceRoomPanels
            isAgentSpeaking={isAgentSpeaking}
            isUserSpeaking={isUserSpeaking}
            muted={muted}
            caption={caption}
            onToggleMute={() => void toggleMute()}
            agentTitle="AI Interviewer"
            agentState={isAgentSpeaking ? "Speaking" : status === "connected" ? "Listening" : "Not connected"}
          />
          <div className="flex justify-center gap-2">
            <button type="button" onClick={repeatLast} className="inline-flex h-10 items-center gap-2 rounded-full border border-line px-5 text-sm text-ink-soft">
              {status === "starting" || status === "connecting" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}
              Repeat
            </button>
          </div>
        </>
      )}
      <div ref={audioRef} aria-hidden />
      {error ? <p className="text-sm text-red-400" role="alert">{error}</p> : null}
    </div>
  );
}
