"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PhoneOff, RotateCcw } from "lucide-react";
import { Room, RoomEvent, Track } from "livekit-client";
import { GenerationConfirmation, type ConfirmableConfig } from "@/components/interview/GenerationConfirmation";
import { VoiceRoomPanels } from "@/components/interview/VoiceRoomPanels";
import { CAPTION_TOPIC } from "@/lib/interview/generation-contract.mjs";
import { applyLatestMuteIntent } from "@/lib/interview/mute-intent";

/**
 * Voice-driven interview generation (FR-SETUP-006). The same two-panel shape
 * as the live room, but the conversation plans the interview instead of
 * running it. Powered by the free Gemini Live + LiveKit stack already in use.
 */
type Status = "starting" | "connecting" | "connected" | "reconnecting" | "completed" | "error";

/** Advisory warning when a dispatched planner never joins the room. */
const NO_AGENT_WARNING = "The planner did not join in time. Leave and start a new voice session.";

/** MDN: MediaStreamTrack.enabled is the real mute switch for captured audio. */
type LocalMicPublication = { audioTrack?: { mediaStreamTrack?: MediaStreamTrack } };

function setBrowserMicEnabled(room: Room | null, enabled: boolean) {
  const publication = room?.localParticipant.getTrackPublication(Track.Source.Microphone) as
    | LocalMicPublication
    | undefined;
  const track = publication?.audioTrack?.mediaStreamTrack;
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
  const startedAtRef = useRef(0);
  const agentPresentRef = useRef(false);
  const noAgentWarningRef = useRef(false);
  const [status, setStatus] = useState<Status>("starting");
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [generation, setGeneration] = useState<GenerationState | null>(null);
  const finishedRef = useRef(false);
  const [callFinished, setCallFinished] = useState(false);
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [liveCaption, setLiveCaption] = useState<{ speaker: "agent" | "candidate"; text: string } | null>(null);
  // The planner's latest spoken line, kept separately from persisted
  // candidate captions so Repeat works before any answer has been stored.
  const [lastPlannerCaption, setLastPlannerCaption] = useState<string | null>(null);
  const [agentPresent, setAgentPresent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Close the voice call once the agent's closing TTS has finished. */
  const finishGeneration = useCallback(() => {
    void roomRef.current?.disconnect();
    setCallFinished(true);
  }, []);

  useEffect(() => {
    // Each effect setup owns its startup. Strict Mode's setup-cleanup-setup
    // replays it, and cleanup invalidates this flag so work started by a dead
    // setup can never attach a room to the live component. A cancelled setup
    // sends no request; preventing duplicates once a POST is in flight is a
    // separate idempotency/server-reuse decision, not guaranteed here.
    let active = true;
    roomRef.current = null;
    startedAtRef.current = Date.now();

    async function start() {
      try {
        // Cleanup may have run before this deferred setup started: do not
        // create an orphaned generation for a component that is already gone.
        if (!active) return;
        const response = await fetch("/api/v1/interviews/generation", { method: "POST" });
        if (!active) return;
        const body = (await response.json().catch(() => null)) as
          | { id?: string; url?: string; token?: string; error?: { message?: string } }
          | null;
        // Cleanup may have finished during the body read; a stale setup must
        // not create or take ownership of a room (Leave/unmount would then
        // target the wrong room and leave the active one publishing).
        if (!active) return;
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
          if (active) {
            setAgentPresent(true);
            // A late join clears only the timed-out warning; never erase an
            // unrelated mic-unavailable or room-failure error.
            setError((current) => (current === NO_AGENT_WARNING ? null : current));
          }
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
        // LiveKit Agents publishes transcriptions on the `lk.transcription`
        // text stream, synchronised with audio playback. Consume the deltas so
        // the candidate sees words as they are spoken, not only final lines.
        room.registerTextStreamHandler("lk.transcription", async (reader, info) => {
          const speaker = (info.identity || "").startsWith("candidate") ? "candidate" : "agent";
          // Keep this stream's text local: the data-channel handler may write a
          // complete caption between deltas, and appending to that caption
          // would duplicate the words already shown.
          let buffer = "";
          try {
            for await (const delta of reader) {
              if (!active) break;
              buffer = (buffer + delta).slice(-2000);
              setLiveCaption({ speaker, text: buffer });
            }
          } catch {
            // A cancelled stream is normal when the agent changes turns.
          }
        });
        room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
          if (!active || topic !== CAPTION_TOPIC) return;
          try {
            const parsed = JSON.parse(new TextDecoder().decode(payload)) as {
              speaker?: string;
              text?: string;
              done?: boolean;
            };
            if (parsed.done) {
              // The agent has finished playing its closing line.
              finishGeneration();
              return;
            }
            if (
              typeof parsed.text === "string" &&
              parsed.text.length > 0 &&
              (parsed.speaker === "agent" || parsed.speaker === "candidate")
            ) {
              setLiveCaption({ speaker: parsed.speaker, text: parsed.text });
              if (parsed.speaker === "agent") setLastPlannerCaption(parsed.text);
            }
          } catch {
            // Ignore malformed data messages; they never affect the call.
          }
        });
        room.on(RoomEvent.Reconnecting, () => {
          if (active) setStatus((current) => (current === "completed" ? current : "reconnecting"));
        });
        room.on(RoomEvent.Reconnected, () => {
          if (active) setStatus((current) => (current === "completed" ? current : "connected"));
        });
        room.on(RoomEvent.Disconnected, () => {
          if (active) setStatus((current) => (current === "completed" ? current : "error"));
        });
        if (active) {
          setGenerationId(body.id);
          setStatus("connecting");
        }
        await room.connect(body.url, body.token);
        // Cleanup may have run while the connection was being negotiated; a
        // cancelled startup must not leave this room connected or publishing.
        if (!active) {
          void room.disconnect();
          return;
        }
        // Participants already in the room never emit ParticipantConnected.
        const earlyParticipant = [...room.remoteParticipants.values()].some(
          (participant) => participant.identity !== room.localParticipant.identity,
        );
        if (earlyParticipant) {
          agentPresentRef.current = true;
          if (active) setAgentPresent(true);
        }
        // Browser mute is applied before any publication exists; the helper
        // then re-reads the intent after each async boundary, so a Mute click
        // while publication is pending cannot leave audio flowing.
        setBrowserMicEnabled(room, !mutedRef.current);
        const published = await applyLatestMuteIntent(
          room.localParticipant,
          () => mutedRef.current,
        );
        if (!active) {
          void room.disconnect();
          return;
        }
        if (!published && active) {
          mutedRef.current = true;
          setMuted(true);
          setError("Microphone unavailable — the planner cannot hear you.");
        }
        setBrowserMicEnabled(room, !mutedRef.current);
        // Polling may already have completed the generation while startup was
        // awaiting the room; never regress that terminal status.
        if (active) setStatus((current) => (current === "completed" ? current : "connected"));
      } catch {
        if (active) {
          setError("The voice generation room could not be reached.");
          setStatus((current) => (current === "completed" ? current : "error"));
        }
      }
    }
    queueMicrotask(() => void start());
    return () => {
      active = false;
      void roomRef.current?.disconnect();
      roomRef.current = null;
    };
  }, [finishGeneration]);

  useEffect(() => {
    if (!generationId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll() {
      let finished = false;
      try {
        const response = await fetch(
          `/api/v1/interviews/generation/${encodeURIComponent(generationId!)}`,
          { cache: "no-store" },
        );
        if (!response.ok || !active) return;
        const data = (await response.json()) as GenerationState;
        if (!active) return;
        setGeneration(data);
        // A failed dispatch leaves the generation "collecting" forever, so
        // warn after a generous grace period for cloud-agent cold starts.
        // This is advisory only: the status, room and Leave button are
        // untouched, and the warning is emitted once per session.
        if (
          data.status === "collecting" &&
          !agentPresentRef.current &&
          !noAgentWarningRef.current &&
          Date.now() - startedAtRef.current > 90_000
        ) {
          noAgentWarningRef.current = true;
          setError(NO_AGENT_WARNING);
        }
        if (data.status === "completed" && data.invitationPath && !finishedRef.current) {
          finishedRef.current = true;
          finished = true;
          setStatus("completed");
          // Do NOT disconnect yet: the worker posts this status BEFORE it
          // speaks the closing line. Wait for the agent's done caption (or a
          // safety timeout for older workers) so the candidate hears it.
          setTimeout(() => finishGeneration(), 12000);
        }
      } catch {
        // Transient poll failure: the next tick retries.
      } finally {
        // Chain the next poll only after this one settles: no overlapping
        // requests, and no polling once the generation is completed.
        if (active && !finished) timer = setTimeout(() => void poll(), 2000);
      }
    }
    void poll();
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [generationId, router, finishGeneration]);

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
    // Confirming only applies the details. The decision happens on its own
    // page, not embedded in the voice room.
    router.push(`/dashboard/interview/${body.sessionId}/ready`);
  }

  function repeatLast() {
    // Repeat planner speech only. The persisted caption may be a candidate
    // answer, and the live transcription stream can hold the only planner
    // line before persistence catches up; never fall back to candidate text.
    const streamText = liveCaption?.speaker === "agent" ? liveCaption.text : null;
    const persisted = generation?.caption?.speaker === "agent" ? generation.caption.text : null;
    const text = lastPlannerCaption ?? streamText ?? persisted;
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

      {status === "completed" && callFinished && generation?.config ? (
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
