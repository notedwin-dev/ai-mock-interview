"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2, MessageSquare, Mic, MicOff, Send, X } from "lucide-react";
import { EndInterviewButton } from "@/components/interview/EndInterviewButton";
import { useOverlayFocusTrap } from "@/components/interview/use-overlay-focus-trap";
import { readDevicePreferences } from "@/lib/interview/device-preferences";
import { acquisitionTrackEnabled } from "@/lib/interview/mute-intent";
import type { InvitationView } from "@/lib/interview/invitations";
import { evaluationModeLabel } from "@/lib/interview/labels";
import type { TranscriptEntry } from "@/lib/interview/room";

/**
 * Live interview room (FR-INTERVIEW-003/004, TT-8 re-layer): two participant
 * panels with AI states and a chronological transcript in an independently
 * openable OVERLAY (never a sidebar). All turns go through the token-scoped
 * API; the camera is never an AI input (ADR-005). Continuous ASR runs only
 * while the candidate has explicitly turned the microphone on (owner decision
 * 2026-11-25); typed answers remain available alongside it.
 */
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
  // Continuous ASR starts with the microphone off; the saved device preference
  // is applied after mount. The ref stays authoritative across async boundaries.
  const [muted, setMuted] = useState(true);
  const mutedRef = useRef(muted);
  const [error, setError] = useState<string | null>(null);

  // Apply the waiting-room device choices after mount (sessionStorage is
  // browser-only, so reading it during render would break SSR hydration).
  useEffect(() => {
    const preferences = readDevicePreferences();
    mutedRef.current = preferences.muted;
    // Defer the state update out of the effect body: sessionStorage is only
    // available after mount, and a synchronous setState here cascades renders.
    queueMicrotask(() => setMuted(preferences.muted));
  }, []);
  const [ended, setEnded] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // True while a getUserMedia request is in flight (ignores duplicate activation).
  const acquisitionPendingRef = useRef(false);
  // Generation identity: bumping it cancels a pending acquisition and any
  // in-flight transcription/turn submission from the previous mic session.
  const recordingGenerationRef = useRef(0);
  // The recorder whose onstop must NOT flush a final window (end/unmount).
  const cancelledRecorderRef = useRef<MediaRecorder | null>(null);
  // A transcription may only replace the draft it started from, and only the
  // newest request may apply its result.
  const draftRevisionRef = useRef(0);
  const transcriptionRequestRef = useRef(0);
  // Monotonic applied-turn counter: a slow initial transcript load may not
  // overwrite messages once a turn has been applied.
  const appliedTurnsRef = useRef(0);
  // Stable per-answer idempotency key: a retry of the SAME answer replays the
  // original turn instead of creating a duplicate.
  const pendingKeyRef = useRef<{ text: string; key: string } | null>(null);
  // Streaming ASR bridge state (Gemini Live transcription relay).
  const streamModeRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const streamIdRef = useRef<string | null>(null);

  /** Releases a track; an already-ended track is a no-op. */
  const stopCaptureTrack = useCallback((track: MediaStreamTrack) => {
    if (track.readyState !== "ended") track.stop();
  }, []);

  /** Stops capture and invalidates every pending result. Used on end/unmount
   *  so no microphone audio can outlive the room or post a late turn. */
  const releaseRecording = useCallback((cancelled: boolean) => {
    cancelledRecorderRef.current = cancelled ? recorderRef.current : null;
    // Bump BEFORE stopping, for a recorder that has no onstop installed yet.
    recordingGenerationRef.current += 1;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state === "recording") {
      try {
        recorder.stop();
      } catch {
        // start() threw after allocating the recorder: tracks are released below.
      }
    }
    if (streamModeRef.current) {
      const id = streamIdRef.current;
      (streamRef.current as (MediaStream & { __stopRelay?: () => void }) | null)?.__stopRelay?.();
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      streamModeRef.current = false;
      streamIdRef.current = null;
      if (id) {
        void fetch(`/api/v1/interviews/invitations/${encodeURIComponent(token)}/asr/stream?streamId=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
      }
    }
    streamRef.current?.getTracks().forEach((track) => stopCaptureTrack(track));
    streamRef.current = null;
  }, [stopCaptureTrack, token]);

  /** Overlay dialog behaviour is shared with the WebRTC room (TT-8 dedup). */
  useOverlayFocusTrap(overlayOpen, overlayRef, () => setOverlayOpen(false));

  // End and unmount both cancel capture: a recording must never post a turn
  // after the interview has ended or the component has gone away.
  useEffect(() => {
    if (!ended) return;
    releaseRecording(true);
  }, [ended, releaseRecording]);

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

  /** Retains one key per answer text so retries deduplicate server-side. */
  function idempotencyKeyFor(contentText: string): string {
    const pending = pendingKeyRef.current;
    const key = pending?.text === contentText ? pending.key : crypto.randomUUID();
    pendingKeyRef.current = { text: contentText, key };
    return key;
  }

  /** Applies a turn result to the transcript, playback and lifecycle. */
  function applyTurnResult(body: {
    messages?: TranscriptEntry[];
    error?: { message: string };
    endCall?: boolean;
    audioBase64?: string | null;
  }): boolean {
    appliedTurnsRef.current += 1;
    setMessages(body.messages ?? []);
    draftRevisionRef.current += 1;
    pendingKeyRef.current = null;
    let audioPlaying = false;
    if (body.audioBase64) {
      try {
        const audio = new Audio(`data:audio/mp3;base64,${body.audioBase64}`);
        // A new answer may have moved the room to "thinking" while this audio
        // was playing; only release the speaking state we own.
        audio.onended = () => setState((current) => (current === "speaking" ? "listening" : current));
        void audio.play().catch(() => undefined);
        audioPlaying = true;
      } catch {
        // Autoplay blocked — the transcript reply is still visible.
      }
    }
    // Only claim "speaking" while audio is actually playing; end wins over both.
    setState(body.endCall || !audioPlaying ? "listening" : "speaking");
    if (body.endCall) {
      releaseRecording(true);
      setEnded(true);
    }
    return true;
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const contentText = draft.trim();
    if (!contentText || state === "thinking") return;
    setError(null);
    setState("thinking");
    const idempotencyKey = idempotencyKeyFor(contentText);
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
        // The draft and its key are preserved so the candidate can retry the
        // exact same answer (the server deduplicates it).
        setError(body.error?.message ?? "The interviewer could not respond.");
        setState("listening");
        return;
      }
      draftRevisionRef.current += 1;
      setDraft("");
      applyTurnResult(body);
    } catch {
      setError("The request could not reach the server.");
      setState("listening");
    }
  }

  /**
   * Continuous transcription (owner decision 2026-11-25): while the microphone
   * is on, audio windows are transcribed by the configured ASR provider and
   * recognised speech becomes a candidate turn. Silence is ignored. A window
   * that resolves after its mic session was cancelled is discarded.
   */
  async function submitWindow(blob: Blob, recorderMime: string) {
    const generation = recordingGenerationRef.current;
    const request = ++transcriptionRequestRef.current;
    const isCurrent = () => generation === recordingGenerationRef.current && request === transcriptionRequestRef.current && !ended;
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      const asr = await fetch(
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
      const asrBody = (await asr.json().catch(() => null)) as { text?: string; error?: { message: string } } | null;
      if (!isCurrent()) return;
      if (!asr.ok || !asrBody?.text?.trim()) return; // silence is normal between turns
      const contentText = asrBody.text.trim();
      const response = await fetch(
        `/api/v1/interviews/invitations/${encodeURIComponent(token)}/turns`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentText, idempotencyKey: idempotencyKeyFor(contentText) }),
        },
      );
      if (!isCurrent()) return;
      const body = (await response.json().catch(() => null)) as {
        messages?: TranscriptEntry[];
        error?: { message: string };
        endCall?: boolean;
        audioBase64?: string | null;
      } | null;
      if (!response.ok || !body) {
        setVoiceNotice(body?.error?.message ?? "The interview could not process that answer.");
        return;
      }
      applyTurnResult(body);
    } catch {
      if (!isCurrent()) return;
      setVoiceNotice("Transcription failed. Check your connection and try turning the microphone on again.");
    }
  }

  /** Feed a live-transcription result into the interview as a candidate turn. */
  async function submitLiveTranscript(text: string, generation: number) {
    const contentText = text.trim();
    if (!contentText || generation !== recordingGenerationRef.current || ended) return;
    const response = await fetch(
      `/api/v1/interviews/invitations/${encodeURIComponent(token)}/turns`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentText, idempotencyKey: idempotencyKeyFor(contentText) }),
      },
    );
    if (generation !== recordingGenerationRef.current || ended) return;
    const body = (await response.json().catch(() => null)) as {
      messages?: TranscriptEntry[];
      error?: { message: string };
      endCall?: boolean;
      audioBase64?: string | null;
    } | null;
    if (!response.ok || !body) return;
    applyTurnResult(body);
  }

  /** Open the server-side Gemini Live transcription bridge for this mic session. */
  async function openLiveBridge(): Promise<boolean> {
    const generation = recordingGenerationRef.current;
    const es = new EventSource(
      `/api/v1/interviews/invitations/${encodeURIComponent(token)}/asr/stream`,
    );
    eventSourceRef.current = es;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 12000);
      es.onmessage = (event) => {
        if (generation !== recordingGenerationRef.current) return;
        const data = JSON.parse(event.data) as { type: string; streamId?: string; text?: string; message?: string };
        if (data.type === "ready" && data.streamId) {
          streamIdRef.current = data.streamId;
          streamModeRef.current = true;
          clearTimeout(timer);
          resolve(true);
        } else if (data.type === "transcript" && data.text) {
          void submitLiveTranscript(data.text, generation);
        } else if (data.type === "error") {
          setVoiceNotice(data.message ?? "Live transcription failed.");
        }
      };
      es.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
  }

  /** Capture 16 kHz 16-bit mono PCM from the live microphone stream. */
  function startPcmRelay(stream: MediaStream, onPcm: (base64: string) => void) {
    const ctx = new AudioContext({ sampleRate: 16000 });
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (ended) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        pcm[i] = Math.max(-1, Math.min(1, input[i])) * 32767;
      }
      const bytes = new Uint8Array(pcm.buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      onPcm(btoa(binary));
    };
    source.connect(processor);
    processor.connect(ctx.destination);
    return () => {
      processor.disconnect();
      source.disconnect();
      void ctx.close();
    };
  }

  async function startMic() {
    // One microphone request at a time: a second activation while the first is
    // pending is ignored instead of acquiring a second stream (and leaking it).
    if (acquisitionPendingRef.current || recorderRef.current?.state === "recording" || ended) return;
    setVoiceNotice(null);
    acquisitionPendingRef.current = true;
    const generation = ++recordingGenerationRef.current;
    try {
      const configResponse = await fetch(
        `/api/v1/interviews/invitations/${encodeURIComponent(token)}/asr/config`,
      );
      const config = configResponse.ok
        ? (await configResponse.json()) as { mode?: string }
        : { mode: "batch" };

      // Prefer the microphone chosen in the waiting room. An "ideal" constraint
      // falls back to the browser default when that device is missing or no
      // longer available.
      const { micId } = readDevicePreferences();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micId ? { deviceId: { ideal: micId } } : true,
      });
      if (generation !== recordingGenerationRef.current || ended) {
        // The room ended/unmounted or a newer activation started while the
        // permission prompt was open: release every track.
        stream.getTracks().forEach((track) => stopCaptureTrack(track));
        return;
      }
      // A Mute click while the permission prompt was pending is newer than
      // this render's `muted`: read the ref so that intent is not lost.
      const trackEnabled = acquisitionTrackEnabled(() => mutedRef.current);
      stream.getAudioTracks().forEach((track) => { track.enabled = trackEnabled; });
      streamRef.current = stream;

      if (config.mode === "stream" && (await openLiveBridge())) {
        if (generation !== recordingGenerationRef.current || ended) {
          stream.getTracks().forEach((track) => stopCaptureTrack(track));
          return;
        }
        const stopRelay = startPcmRelay(stream, (base64) => {
          const id = streamIdRef.current;
          if (!id) return;
          void fetch(`/api/v1/interviews/invitations/${encodeURIComponent(token)}/asr/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ streamId: id, audioBase64: base64 }),
          }).catch(() => undefined);
        });
        (stream as MediaStream & { __stopRelay?: () => void }).__stopRelay = stopRelay;
        streamModeRef.current = true;
        setMuted(false);
        return;
      }

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream);
      } catch (error) {
        stream.getTracks().forEach((track) => stopCaptureTrack(track));
        streamRef.current = null;
        throw error;
      }
      let pending: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) pending.push(event.data);
      };
      recorder.onstop = () => {
        // Cancel (end/unmount) never posts a turn; a normal stop flushes the
        // final window and always releases the tracks.
        const cancel = cancelledRecorderRef.current === recorder;
        if (cancelledRecorderRef.current === recorder) cancelledRecorderRef.current = null;
        if (!cancel && pending.length > 0) {
          const window = new Blob(pending, { type: recorder.mimeType || "audio/webm" });
          pending = [];
          void submitWindow(window, recorder.mimeType);
        }
        stream.getTracks().forEach((track) => stopCaptureTrack(track));
        if (streamRef.current === stream) streamRef.current = null;
        if (recorderRef.current === recorder) recorderRef.current = null;
      };
      recorderRef.current = recorder;
      try {
        // A window every 4 s keeps transcription near-real-time; each call is
        // idempotency-keyed.
        recorder.start(4000);
      } catch (error) {
        recorderRef.current = null;
        stream.getTracks().forEach((track) => stopCaptureTrack(track));
        if (streamRef.current === stream) streamRef.current = null;
        throw error;
      }
      setMuted(false);
    } catch {
      setVoiceNotice("Microphone access was not granted. You can type your answer instead.");
    } finally {
      acquisitionPendingRef.current = false;
    }
  }

  function toggleMic() {
    if (!muted) {
      setMuted(true);
      if (streamModeRef.current) {
        const id = streamIdRef.current;
        (streamRef.current as (MediaStream & { __stopRelay?: () => void }) | null)?.__stopRelay?.();
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        streamModeRef.current = false;
        streamIdRef.current = null;
        if (id) {
          void fetch(`/api/v1/interviews/invitations/${encodeURIComponent(token)}/asr/stream?streamId=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
        }
      } else {
        // onstop flushes the final audio window before releasing the tracks.
        recorderRef.current?.stop();
      }
      streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = false; });
      return;
    }
    void startMic();
  }

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

      {/*
       * Profile / video frames. A frame shows ONLY the participant's picture
       * (avatar here; a local camera preview would sit in the same slot).
       * Speaker state is conveyed by a quiet ring, never by text. Transcripts,
       * statuses and controls live in their own surfaces: the conversation
       * overlay and the answer bar below.
       */}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
        <section aria-label="AI interviewer" className="flex min-h-[18rem] flex-col items-center justify-center rounded-3xl border border-line bg-surface p-8">
          <span aria-hidden className={`flex h-24 w-24 items-center justify-center rounded-full border-2 text-3xl font-bold transition-colors ${state === "speaking" ? "border-emerald-400 bg-emerald-400/15 text-emerald-300 animate-pulse" : "border-line bg-raised text-ink-soft"}`}>A</span>
          <span className="sr-only">{state === "speaking" ? "AI interviewer is speaking" : "AI interviewer"}</span>
        </section>

        <section aria-label="You" className="flex min-h-[18rem] flex-col items-center justify-center rounded-3xl border border-line bg-surface p-8">
          <span aria-hidden className="flex h-24 w-24 items-center justify-center rounded-full border-2 border-line bg-raised text-3xl font-bold text-ink-soft">Y</span>
          <span className="sr-only">You</span>
        </section>
      </div>

      {ended ? (
        <div className="rounded-2xl border border-emerald-400/40 bg-surface p-5 text-sm text-ink">
          The interview has ended. Your transcript has been saved.
        </div>
      ) : (
        <>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line bg-surface px-4 py-2">
          <p className="text-xs text-ink-muted">
            Your camera is never used as AI input. While the microphone is on, your speech is transcribed in real time and shared with the interviewer.
          </p>
          <button
            type="button"
            onClick={toggleMic}
            aria-pressed={!muted}
            className="btn-ghost">
            {muted ? <Mic className="h-4 w-4" aria-hidden /> : <MicOff className="h-4 w-4" aria-hidden />}
            {muted ? "Turn on microphone" : "Turn off microphone"}
          </button>
        </div>
        <form onSubmit={(event) => void send(event)} className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4 sm:flex-row sm:items-center">
          <input
            value={draft}
            onChange={(event) => {
              // A candidate edit invalidates any in-flight transcription
              // result: it must never overwrite text typed afterwards.
              draftRevisionRef.current += 1;
              setDraft(event.target.value);
            }}
            className="h-11 flex-1 rounded-full border border-line bg-raised px-5 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-emerald-400/70"
            placeholder="Or type your answer…"
            maxLength={5000}
            aria-label="Your interview answer"
            disabled={state === "thinking"}
          />
          <button type="submit" disabled={!draft.trim() || state === "thinking"} className="btn-primary">
            {state === "thinking" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
            Send
          </button>
        </form>
        </>
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
