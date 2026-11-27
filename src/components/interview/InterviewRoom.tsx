"use client";

// Combined: our mic-lifecycle hooks (useCallback) plus the runtime batch's UI
// additions (mute control and the explicit end-interview action).
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2, MessageSquare, Mic, MicOff, Send, X } from "lucide-react";
import { EndInterviewButton } from "@/components/interview/EndInterviewButton";
import type { InvitationView } from "@/lib/interview/invitations";
import { evaluationModeLabel } from "@/lib/interview/labels";
import type { TranscriptEntry } from "@/lib/interview/room";

/**
 * Live interview room (FR-INTERVIEW-003/004, TT-8 re-layer): two participant
 * panels with AI states and a chronological transcript in an independently
 * openable OVERLAY (never a sidebar). All turns go through the token-scoped
 * API; the camera is never an AI input (ADR-005). Microphone audio is sent to
 * the configured ASR provider only after the candidate presses Record answer.
 */
const GHOST =
  "inline-flex h-10 items-center gap-2 rounded-full border border-line px-4 text-sm text-ink-soft outline-none transition-colors hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-emerald-400";

/** Candidate-facing wording; storage-level message kinds stay out of the UI. */
function messageKindLabel(message: TranscriptEntry): string {
  if (message.speakerType === "candidate") return "Answer";
  if (message.messageKind === "primary_question") return "Question";
  if (message.messageKind === "follow_up_question") return "Follow-up";
  return "Interviewer";
}

export function InterviewRoom({ token, interview }: { token: string; interview: InvitationView }) {
  const [messages, setMessages] = useState<TranscriptEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<"listening" | "thinking" | "speaking">("listening");
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  // Monotonic counter for applied turn results: the initial transcript load
  // may only overwrite messages when no turn has been applied since it
  // started, so a slow load can never clobber a completed turn.
  const appliedTurnsRef = useRef(0);
  // The idempotency key retained with the unanswered draft: a resubmission of
  // the SAME answer reuses it (the server deduplicates the turn); a different
  // answer or a received response discards it.
  const pendingKeyRef = useRef<{ text: string; key: string } | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [recording, setRecording] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // True while a getUserMedia request is in flight (ignores duplicate activation).
  const acquisitionPendingRef = useRef(false);
  // Identity of the current microphone acquisition. Bumping it cancels a
  // pending getUserMedia result and tells the recorder's onstop not to submit.
  const recordingGenerationRef = useRef(0);
  // The recorder whose onstop must NOT submit (cancelled by end/unmount/cancel).
  // onstop always releases the tracks; only submitting is gated.
  const cancelledRecorderRef = useRef<MediaRecorder | null>(null);
  // Draft and transcription identities: a transcription may only replace the
  // draft it started from, and only the newest request may apply.
  const draftRevisionRef = useRef(0);
  const transcriptionRequestRef = useRef(0);

  // Releases a microphone track; a track already ended (e.g. by MediaRecorder.stop())
  // is a no-op. Declared before releaseRecording so the callback sees it.
  const stopCaptureTrack = useCallback((track: MediaStreamTrack) => {
    if (track.readyState !== "ended") track.stop();
  }, []);

  /**
   * Stops the active capture and invalidates any pending acquisition. With
   * `cancelled: true` the active recorder's onstop will neither submit the audio
   * nor touch the (already released) stream — used when the interview ends or
   * the room unmounts, so a cancel can never post a turn.
   */
  const releaseRecording = useCallback((cancelled: boolean) => {
    cancelledRecorderRef.current = cancelled ? recorderRef.current : null;
    // Bump the generation BEFORE stopping, for a recorder that has no onstop
    // installed yet (still starting in an ended/unmounted room).
    recordingGenerationRef.current += 1;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state === "recording") {
      try {
        recorder.stop();
      } catch {
        // start() threw after allocating the recorder: nothing is capturing and
        // onstop will not fire, so the tracks are released below instead.
      }
    }
    streamRef.current?.getTracks().forEach((track) => stopCaptureTrack(track));
    streamRef.current = null;
  }, [stopCaptureTrack]);

  // Unmount and interview end both cancel capture: a recording must never
  // outlive the room or be submitted after the interview has ended.
  useEffect(() => {
    if (!ended) return;
    releaseRecording(true);
  }, [ended, releaseRecording]);

  // Unmount releases the microphone too (and suppresses any in-flight submit).
  useEffect(() => () => releaseRecording(true), [releaseRecording]);

  useEffect(() => {
    let active = true;
    const loadGeneration = appliedTurnsRef.current;
    const load = async () => {
      try {
        const response = await fetch(`/api/v1/interviews/invitations/${encodeURIComponent(token)}/turns`, { cache: "no-store" });
        if (response.ok && active && appliedTurnsRef.current === loadGeneration) {
          const data = (await response.json()) as { messages: TranscriptEntry[] };
          setMessages(data.messages);
        }
      } catch {
        // The next turn will retry; the room remains usable.
      }
    };
    void load();
    return () => { active = false; };
  }, [token]);

  // Conversation overlay focus management: move focus inside when it opens,
  // keep Tab navigation within it, close on Escape and restore focus to the
  // opener when it closes.
  useEffect(() => {
    if (!overlayOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = overlayRef.current;
    const focusables = panel
      ? Array.from(
          panel.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        )
      : [];
    (focusables[0] ?? panel)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOverlayOpen(false);
        return;
      }
      if (event.key !== "Tab" || focusables.length === 0) return;
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
      previouslyFocused?.focus();
    };
  }, [overlayOpen]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const contentText = draft.trim();
    if (!contentText || state === "thinking") return;
    setError(null);
    setState("thinking");
    const pending = pendingKeyRef.current;
    const idempotencyKey = pending?.text === contentText ? pending.key : crypto.randomUUID();
    pendingKeyRef.current = { text: contentText, key: idempotencyKey };
    try {
      const response = await fetch(`/api/v1/interviews/invitations/${encodeURIComponent(token)}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentText, idempotencyKey }),
      });
      const body = (await response.json()) as {
        messages?: TranscriptEntry[];
        error?: { message: string };
        endCall?: boolean;
        audioBase64?: string | null;
      };
      if (!response.ok) {
        // The draft and its idempotency key are preserved so the candidate
        // can retry the exact same answer.
        setError(body.error?.message ?? "The interviewer could not respond.");
        setState("listening");
        return;
      }
      appliedTurnsRef.current += 1;
      setMessages(body.messages ?? []);
      draftRevisionRef.current += 1;
      setDraft("");
      pendingKeyRef.current = null;
      // Voice playback is best-effort: the transcript is the source of truth.
      let audioPlaying = false;
      if (body.audioBase64) {
        try {
          const audio = new Audio(`data:audio/mp3;base64,${body.audioBase64}`);
          audio.onended = () => setState("listening");
          void audio.play().catch(() => undefined);
          audioPlaying = true;
        } catch {
          // Browser blocked autoplay — the text reply is still visible.
        }
      }
      // Only claim "speaking" while audio is actually playing; end wins over
      // both, and capture is cancelled so no late audio can post a turn.
      setState(body.endCall || !audioPlaying ? "listening" : "speaking");
      if (body.endCall) {
        releaseRecording(true);
        setRecording(false);
        setEnded(true);
      }
    } catch {
      setError("The request could not reach the server.");
      setState("listening");
    }
  }

  async function submitAudio(blob: Blob, recorderMime: string) {
    // Identity of this transcription: it may only replace the draft it
    // started from, and only the newest request may apply its result. The
    // revision is bumped on every candidate-side draft change.
    const request = ++transcriptionRequestRef.current;
    const startedAtRevision = draftRevisionRef.current;
    const isCurrent = () =>
      request === transcriptionRequestRef.current &&
      startedAtRevision === draftRevisionRef.current;
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      const response = await fetch(
        `/api/v1/interviews/invitations/${encodeURIComponent(token)}/transcribe`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audioBase64: btoa(binary),
            mimeType: (recorderMime || blob.type || "audio/webm").split(";")[0],
          }),
        },
      );
      if (!isCurrent()) return;
      const body = (await response.json()) as { text?: string; error?: { message: string } };
      if (!response.ok) {
        setVoiceNotice(body.error?.message ?? "The recording could not be transcribed.");
        return;
      }
      // The transcript goes into the input for review — nothing is sent until
      // the candidate explicitly presses Send. A draft the candidate typed or
      // edited while this request was in flight is never clobbered.
      draftRevisionRef.current += 1;
      setDraft(body.text ?? "");
      setVoiceNotice("Voice transcribed — review the text, then press Send.");
    } catch {
      if (!isCurrent()) return;
      setVoiceNotice("The recording could not be transcribed.");
    }
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
  }

  async function startRecording() {
    // One microphone request at a time: a second activation while the first is
    // still pending is ignored instead of acquiring a second stream (and
    // leaking the first).
    if (acquisitionPendingRef.current || recorderRef.current?.state === "recording") return;
    setVoiceNotice(null);
    acquisitionPendingRef.current = true;
    const generation = ++recordingGenerationRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== recordingGenerationRef.current) {
        // The room ended / unmounted / recorded again while the permission
        // prompt was open: this acquisition is stale. Release every track so
        // the microphone is free and the indicator goes away.
        stream.getTracks().forEach((track) => stopCaptureTrack(track));
        return;
      }
      // Honour the mute preference chosen in the room/waiting room.
      stream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
      streamRef.current = stream;

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream);
      } catch (error) {
        stream.getTracks().forEach((track) => stopCaptureTrack(track));
        streamRef.current = null;
        throw error;
      }

      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        // Cancel (the interview ended or the room unmounted) must never post a
        // turn; a normal stop submits once and never leaves the mic open.
        const cancel = cancelledRecorderRef.current === recorder;
        if (cancelledRecorderRef.current === recorder) cancelledRecorderRef.current = null;
        stream.getTracks().forEach((track) => stopCaptureTrack(track));
        if (streamRef.current === stream) streamRef.current = null;
        if (recorderRef.current === recorder) recorderRef.current = null;
        if (!cancel && chunks.length > 0) {
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          void submitAudio(blob, recorder.mimeType);
        }
        setRecording(false);
      };
      recorderRef.current = recorder;
      try {
        recorder.start();
      } catch (error) {
        // start() threw after the recorder was allocated: release the tracks
        // right away and both refs before surfacing the failure.
        recorderRef.current = null;
        stream.getTracks().forEach((track) => stopCaptureTrack(track));
        if (streamRef.current === stream) streamRef.current = null;
        throw error;
      }
      setRecording(true);
    } catch {
      setVoiceNotice("Microphone access was not granted. You can type your answer instead.");
    } finally {
      acquisitionPendingRef.current = false;
    }
  }

  const lastInterviewer = [...messages].reverse().find((m) => m.speakerType === "interviewer");

  return (
    <div className="flex min-h-[calc(100vh-2rem)] flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-5 py-3">
        <div>
          <h1 className="font-display text-lg font-semibold text-ink">Mock interview · {interview.jobRole}</h1>
          <p className="text-xs text-ink-muted">{interview.categoryNameSnapshot} · {evaluationModeLabel(interview.evaluationMode)} mode</p>
        </div>
        <button type="button" onClick={() => setOverlayOpen((open) => !open)} className="btn-ghost">
          {overlayOpen ? <X className="h-4 w-4" aria-hidden /> : <MessageSquare className="h-4 w-4" aria-hidden />}
          {overlayOpen ? "Hide conversation" : "Open conversation"}
        </button>
      </header>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
        <section aria-label="AI interviewer" className="flex min-h-[18rem] flex-col items-center justify-center rounded-3xl border border-line bg-surface p-8 text-center">
          <span aria-hidden className={`flex h-20 w-20 items-center justify-center rounded-full border text-2xl font-bold ${state === "speaking" ? "border-emerald-400 bg-emerald-400/15 text-emerald-300" : "border-line bg-raised text-ink-soft"}`}>A</span>
          <h2 className="mt-4 text-sm font-semibold text-ink">AI Interviewer</h2>
          <p className="mt-1 text-xs capitalize text-ink-muted">
            {state === "thinking" ? "thinking…" : state === "speaking" ? "speaking" : "listening"}
          </p>
          {lastInterviewer ? (
            <p className="mt-4 max-w-md text-sm leading-relaxed text-ink-soft">{lastInterviewer.contentText}</p>
          ) : (
            <p className="mt-4 max-w-md text-sm text-ink-muted">Introduce yourself to start the interview.</p>
          )}
        </section>

        <section aria-label="You" className="flex min-h-[18rem] flex-col items-center justify-center rounded-3xl border border-line bg-surface p-8 text-center">
          <span aria-hidden className="flex h-20 w-20 items-center justify-center rounded-full border border-line bg-raised text-2xl font-bold text-ink-soft">Y</span>
          <h2 className="mt-4 text-sm font-semibold text-ink">You</h2>
          <p className="mt-1 text-xs text-ink-muted">{muted ? "Microphone muted" : "Microphone ready"}</p>
          <button
            type="button"
            onClick={toggleMute}
            aria-pressed={muted}
            className={`${GHOST} mt-4`}>
            {muted ? <MicOff className="h-4 w-4" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
            {muted ? "Unmute" : "Mute"}
          </button>
          <p className="mt-3 text-xs text-ink-muted">Type your answers below.</p>
          <p className="mt-3 max-w-xs text-xs text-ink-muted">
            Your camera is never used as AI input. Microphone audio is sent to the configured ASR provider only when you press Record answer.
          </p>
        </section>
      </div>

      {ended ? (
        <div className="rounded-2xl border border-emerald-400/40 bg-surface p-5 text-sm text-ink">
          The interview has ended. Your transcript has been saved.
        </div>
      ) : (
        <form onSubmit={(event) => void send(event)} className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4 sm:flex-row sm:items-center">
          <input
            value={draft}
            onChange={(event) => {
              // A candidate edit invalidates any in-flight transcription result:
              // it must never overwrite text the candidate typed afterwards.
              draftRevisionRef.current += 1;
              setDraft(event.target.value);
            }}
            className="h-11 flex-1 rounded-full border border-line bg-raised px-5 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-emerald-400/70"
            placeholder="Type your answer…"
            maxLength={5000}
            aria-label="Your interview answer"
            disabled={state === "thinking"}
          />
          <button
            type="button"
            onClick={() => (recording ? recorderRef.current?.stop() : void startRecording())}
            className="btn-ghost"
            aria-label={recording ? "Stop recording" : "Record answer"}
          >
            {recording ? (
              <><span aria-hidden className="h-2.5 w-2.5 rounded-full bg-red-400" /> Stop recording</>
            ) : (
              <><Mic className="h-4 w-4" aria-hidden /> Record answer</>
            )}
          </button>
          <button type="submit" disabled={!draft.trim() || state === "thinking"} className="btn-primary">
            {state === "thinking" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
            Send
          </button>
        </form>
      )}
      {!ended ? (
        <div className="flex justify-center">
          <EndInterviewButton
            token={token}
            feedbackHref={`/dashboard/interview/${interview.sessionId}/feedback`}
            onEnded={() => {
              setEnded(true);
              setOverlayOpen(false);
            }}
          />
        </div>
      ) : null}
      {voiceNotice ? <p className="text-sm text-amber-300" role="status">{voiceNotice}</p> : null}
      {error ? <p className="text-sm text-red-400" role="alert">{error}</p> : null}

      {overlayOpen ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60" role="dialog" aria-modal="true" aria-labelledby="conversation-heading" aria-label="Conversation transcript">
          <button type="button" aria-label="Close conversation" onClick={() => setOverlayOpen(false)} className="absolute inset-0 cursor-default" />
          <div
            ref={overlayRef}
            tabIndex={-1}
            className="relative z-10 flex h-full w-full max-w-md flex-col gap-3 overflow-y-auto border-l border-line bg-surface p-5 outline-none"
          >
            <div className="flex items-center justify-between">
              <h2 id="conversation-heading" className="font-display text-lg font-semibold text-ink">Conversation</h2>
              <button type="button" onClick={() => setOverlayOpen(false)} className="btn-ghost">Close</button>
            </div>
            {messages.length === 0 ? (
              <p className="text-sm text-ink-muted">No turns yet. Introduce yourself to begin.</p>
            ) : (
              messages.map((message) => (
                <div key={message.sequenceNumber} className={`max-w-[90%] rounded-2xl px-4 py-2 text-sm ${message.speakerType === "candidate" ? "self-end bg-emerald-400/15 text-ink" : "self-start bg-raised text-ink-soft"}`}>
                  <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-ink-muted">
                    {message.speakerType === "candidate" ? "You" : "AI"} · {messageKindLabel(message)}
                  </span>
                  {message.contentText}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
