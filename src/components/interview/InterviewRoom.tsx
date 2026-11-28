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

/** Turn response body shared by the typed, batch and live answer paths. */
type TurnBody = {
  messages?: TranscriptEntry[];
  error?: { message: string };
  endCall?: boolean;
  audioBase64?: string | null;
};

/** A live answer whose delivery failed, kept with its own idempotency key. */
type LiveRetry = { text: string; key: string; generation: number };

/** Bounds a teardown wait so mic-off cannot hang on a stalled request. */
function withDeadline<T>(work: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!work) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(undefined); },
    );
  });
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
  // A transcription may only replace the draft it started from.
  const draftRevisionRef = useRef(0);
  // Monotonic applied-turn counter: a slow initial transcript load may not
  // overwrite messages once a turn has been applied.
  const appliedTurnsRef = useRef(0);
  // Stable per-answer idempotency key for the TYPED draft. Voice turns use
  // their own key so a live transcript cannot invalidate a pending typed retry.
  const pendingKeyRef = useRef<{ text: string; key: string } | null>(null);
  const voiceKeyRef = useRef<{ text: string; key: string } | null>(null);
  // Each live answer that failed to reach the server is kept with its own key
  // so a second failure cannot hide or overwrite the first one's retry.
  const [liveRetries, setLiveRetries] = useState<LiveRetry[]>([]);
  // Playback callbacks are token-guarded so an older reply cannot change the
  // state of a newer one.
  const playbackTokenRef = useRef(0);
  // The batch recorder is stopped/restarted at each window boundary so every
  // submitted window is a complete, independently decodable recording.
  const batchLoopRef = useRef<{ stop: (finalFlush: boolean) => void } | null>(null);
  // Streaming ASR bridge state (Gemini Live transcription relay).
  const streamModeRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const streamIdRef = useRef<string | null>(null);
  // A typed answer owns the "thinking" lock until its own request settles;
  // a voice reply must not unlock the form early.
  const typedRequestPendingRef = useRef(false);
  // Voice results are applied in capture order, never in response order.
  const turnSequenceRef = useRef(0);
  const nextTurnSequenceRef = useRef(0);
  // A null generation marks a typed turn, which must survive mic-session changes.
  const pendingTurnResultsRef = useRef(new Map<number, { generation: number | null; body: TurnBody | null }>());
  // Reconnects emit a new stream id; queued PCM posts must be retargeted to it.
  const bridgeRetargetRef = useRef<((streamId: string) => void) | null>(null);
  // Last live-bridge failure, reported when the configured bridge cannot start.
  const bridgeErrorRef = useRef<string | null>(null);

  /** Releases a track; an already-ended track is a no-op. */
  const stopCaptureTrack = useCallback((track: MediaStreamTrack) => {
    if (track.readyState !== "ended") track.stop();
  }, []);

  /** Stops capture and invalidates every pending result. Used on end/unmount
   *  so no microphone audio can outlive the room or post a late turn. */
  const releaseRecording = useCallback((cancelled: boolean) => {
    // End/unmount discards pending audio and prevents a batch-window restart.
    batchLoopRef.current?.stop(false);
    playbackTokenRef.current += 1;
    cancelledRecorderRef.current = cancelled ? recorderRef.current : null;
    // Bump BEFORE stopping, for a recorder that has no onstop installed yet.
    recordingGenerationRef.current += 1;
    // Cancelled captures still settle their ordered slots as no-ops, so the
    // queue keeps advancing without applying their transcript.
    bridgeRetargetRef.current = null;
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
      void (streamRef.current as (MediaStream & { __stopRelay?: () => Promise<void> }) | null)?.__stopRelay?.();
      // Ask the server to finalize before closing SSE; the provider's last
      // transcript may still be in flight. End/unmount use immediate teardown
      // rather than the mic-off grace wait.
      if (id) {
        void fetch(`/api/v1/interviews/invitations/${encodeURIComponent(token)}/asr/stream?streamId=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
      }
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      streamModeRef.current = false;
      streamIdRef.current = null;
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

  /** Retains one key per typed answer so retries deduplicate server-side. */
  function idempotencyKeyFor(contentText: string): string {
    const pending = pendingKeyRef.current;
    const key = pending?.text === contentText ? pending.key : crypto.randomUUID();
    pendingKeyRef.current = { text: contentText, key };
    return key;
  }

  /** Voice turns own their key, separate from the typed draft's retry key. */
  function voiceIdempotencyKeyFor(contentText: string): string {
    const pending = voiceKeyRef.current;
    const key = pending?.text === contentText ? pending.key : crypto.randomUUID();
    voiceKeyRef.current = { text: contentText, key };
    return key;
  }

  /** Applies a turn result to the transcript, playback and lifecycle.
   *  State transitions belong to the caller that owns the request. */
  function applyTurnResult(body: TurnBody): boolean {
    appliedTurnsRef.current += 1;
    setMessages(body.messages ?? []);
    draftRevisionRef.current += 1;
    // A reply is applied once; the caller clears the key that owns it so a
    // failed typed/voice retry keeps its own independent key.
    const playbackToken = ++playbackTokenRef.current;
    if (body.audioBase64) {
      try {
        const audio = new Audio(`data:audio/mp3;base64,${body.audioBase64}`);
        // Only this reply's callbacks may change the speaking state; an older
        // audio element that finishes late is ignored.
        audio.onended = () => {
          if (playbackTokenRef.current !== playbackToken || ended) return;
          setState((current) => (current === "speaking" ? "listening" : current));
        };
        // Autoplay can be rejected asynchronously: stay "listening" until the
        // browser confirms playback actually started.
        void audio.play().then(() => {
          if (playbackTokenRef.current === playbackToken && !ended) setState("speaking");
        }).catch(() => undefined);
      } catch {
        // Autoplay blocked — the transcript reply is still visible.
      }
    }
    if (body.endCall) {
      releaseRecording(true);
      setEnded(true);
    }
    return true;
  }

  /** Applies voice results in capture order. A slow later reply cannot
   *  overwrite the transcript of an earlier one, and results from a cancelled
   *  mic session are discarded instead of blocking the queue. */
  function applyOrderedTurn(sequence: number, generation: number | null, body: TurnBody | null) {
    const pending = pendingTurnResultsRef.current;
    pending.set(sequence, { generation, body });
    // Consume every settled slot in order. A cancelled mic session's slots are
    // skipped without applying their transcript, but still advance the queue.
    while (pending.has(nextTurnSequenceRef.current)) {
      const next = pending.get(nextTurnSequenceRef.current);
      pending.delete(nextTurnSequenceRef.current);
      nextTurnSequenceRef.current += 1;
      if (!next?.body || ended) continue;
      if (next.generation !== null && next.generation !== recordingGenerationRef.current) continue;
      applyTurnResult(next.body);
      // A typed request keeps the form locked until its own response arrives.
      if (!typedRequestPendingRef.current) setState("listening");
    }
  }

  /** Adds a live-answer delivery failure to the retryable state. */
  function keepLiveAnswerForRetry(contentText: string, key: string, generation: number, message: string) {
    setVoiceNotice(message);
    setLiveRetries((current) => current.some((item) => item.key === key)
      ? current
      : [...current, { text: contentText, key, generation }]);
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const contentText = draft.trim();
    if (!contentText || state === "thinking") return;
    setError(null);
    typedRequestPendingRef.current = true;
    setState("thinking");
    const idempotencyKey = idempotencyKeyFor(contentText);
    // Typed turns share the capture-order queue with voice turns so a slow
    // earlier voice reply cannot overwrite a newer typed answer.
    const sequence = ++turnSequenceRef.current;
    try {
      const response = await fetch(`/api/v1/interviews/invitations/${encodeURIComponent(token)}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentText, idempotencyKey }),
      });
      const body = (await response.json()) as TurnBody;
      if (!response.ok) {
        // The draft and its key are preserved so the candidate can retry the
        // exact same answer (the server deduplicates it).
        setError(body.error?.message ?? "The interviewer could not respond.");
        applyOrderedTurn(sequence, null, null);
        setState("listening");
        return;
      }
      draftRevisionRef.current += 1;
      // The typed operation succeeded: its retry key is no longer needed.
      pendingKeyRef.current = null;
      setDraft("");
      applyOrderedTurn(sequence, null, body);
      setState("listening");
    } catch {
      setError("The request could not reach the server.");
      applyOrderedTurn(sequence, null, null);
      setState("listening");
    } finally {
      // Only THIS request releases the typed-form lock; a concurrent voice
      // turn cannot unlock the form while the typed answer is still pending.
      typedRequestPendingRef.current = false;
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
    // Sequence at capture time: responses are applied in this order, not in
    // the order the provider answers them.
    const sequence = ++turnSequenceRef.current;
    const isCurrent = () => generation === recordingGenerationRef.current && !ended;
    // A cancelled window still settles its ordered slot as a no-op.
    const settle = () => applyOrderedTurn(sequence, generation, null);
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
      if (!isCurrent()) { settle(); return; }
      const asrBody = (await asr.json().catch(() => null)) as { text?: string; error?: { message: string } } | null;
      if (!isCurrent()) { settle(); return; }
      // A provider failure is not silence: surface it instead of dropping it.
      if (!asr.ok) {
        setVoiceNotice(asrBody?.error?.message ?? "Transcription failed. Check your connection and try again.");
        applyOrderedTurn(sequence, generation, null);
        return;
      }
      if (!asrBody?.text?.trim()) {
        applyOrderedTurn(sequence, generation, null); // silence is normal between turns
        return;
      }
      const contentText = asrBody.text.trim();
      const response = await fetch(
        `/api/v1/interviews/invitations/${encodeURIComponent(token)}/turns`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentText, idempotencyKey: voiceIdempotencyKeyFor(contentText) }),
        },
      );
      if (!isCurrent()) { settle(); return; }
      const body = (await response.json().catch(() => null)) as TurnBody | null;
      // The interview may have ended while the turn response was being read.
      if (!isCurrent()) { settle(); return; }
      if (!response.ok || !body) {
        setVoiceNotice(body?.error?.message ?? "The interview could not process that answer.");
        applyOrderedTurn(sequence, generation, null);
        return;
      }
      voiceKeyRef.current = null;
      applyOrderedTurn(sequence, generation, body);
    } catch {
      if (!isCurrent()) { settle(); return; }
      setVoiceNotice("Transcription failed. Check your connection and try turning the microphone on again.");
      applyOrderedTurn(sequence, generation, null);
    }
  }

  /** Feed a live-transcription result into the interview as a candidate turn. */
  async function submitLiveTranscript(text: string, generation: number, retryKey?: string) {
    const contentText = text.trim();
    if (!contentText || generation !== recordingGenerationRef.current || ended) return;
    const idempotencyKey = retryKey ?? voiceIdempotencyKeyFor(contentText);
    // A retry is a new submission: it takes a new capture-order slot.
    const sequence = ++turnSequenceRef.current;
    const settle = () => applyOrderedTurn(sequence, generation, null);
    try {
      const response = await fetch(
        `/api/v1/interviews/invitations/${encodeURIComponent(token)}/turns`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentText, idempotencyKey }),
        },
      );
      if (generation !== recordingGenerationRef.current || ended) { settle(); return; }
      const body = (await response.json().catch(() => null)) as TurnBody | null;
      // Cleanup may have invalidated this capture during the response read.
      if (generation !== recordingGenerationRef.current || ended) { settle(); return; }
      if (!response.ok || !body) {
        // Keep the recognised answer and its key: the server may have rolled
        // the candidate back, so replaying the same key is safe.
        keepLiveAnswerForRetry(
          contentText,
          idempotencyKey,
          generation,
          body?.error?.message ?? "The interviewer could not accept that answer.",
        );
        applyOrderedTurn(sequence, generation, null);
        return;
      }
      voiceKeyRef.current = null;
      setLiveRetries((current) => current.filter((item) => item.key !== idempotencyKey));
      applyOrderedTurn(sequence, generation, body);
    } catch {
      if (generation !== recordingGenerationRef.current || ended) { settle(); return; }
      keepLiveAnswerForRetry(
        contentText,
        idempotencyKey,
        generation,
        "The answer could not be sent. Check your connection and retry.",
      );
      applyOrderedTurn(sequence, generation, null);
    }
  }

  /** Open the server-side Gemini Live transcription bridge for this mic session. */
  async function openLiveBridge(): Promise<boolean> {
    const generation = recordingGenerationRef.current;
    const es = new EventSource(
      `/api/v1/interviews/invitations/${encodeURIComponent(token)}/asr/stream`,
    );
    eventSourceRef.current = es;
    bridgeErrorRef.current = null;
    return await new Promise<boolean>((resolve) => {
      let ready = false;
      let settled = false;
      // Before `ready` a failure closes the bridge so the caller can retry the
      // SAME provider. After `ready` the EventSource stays open so it can
      // reconnect — closing it would strand a live bridge with no transcript.
      const detach = () => {
        if (eventSourceRef.current === es) eventSourceRef.current = null;
        es.onmessage = null;
        es.onerror = null;
        es.close();
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detach();
        bridgeErrorRef.current = message;
        resolve(false);
      };
      const timer = setTimeout(
        () => fail("Live transcription did not start. Check your connection and try again."),
        12000,
      );
      es.onmessage = (event) => {
        if (generation !== recordingGenerationRef.current || ended) {
          fail("Live transcription was cancelled.");
          return;
        }
        const data = JSON.parse(event.data) as { type: string; streamId?: string; text?: string; message?: string };
        if (data.type === "ready" && data.streamId) {
          if (ready) {
            // The bridge reconnected: retarget queued PCM posts and release the
            // superseded server stream instead of posting into a closed one.
            const previous = streamIdRef.current;
            streamIdRef.current = data.streamId;
            bridgeRetargetRef.current?.(data.streamId);
            if (previous && previous !== data.streamId) {
              void fetch(`/api/v1/interviews/invitations/${encodeURIComponent(token)}/asr/stream?streamId=${encodeURIComponent(previous)}`, { method: "DELETE" }).catch(() => undefined);
            }
            return;
          }
          ready = true;
          settled = true;
          streamIdRef.current = data.streamId;
          streamModeRef.current = true;
          clearTimeout(timer);
          // Keep the bridge open: it must keep delivering transcripts.
          resolve(true);
        } else if (data.type === "transcript" && data.text) {
          void submitLiveTranscript(data.text, generation);
        } else if (data.type === "error") {
          const message = data.message ?? "Live transcription failed.";
          if (!ready) fail(message);
          else setVoiceNotice(message);
        }
      };
      es.onerror = () => {
        if (!ready) fail("Live transcription connection failed. Check your connection and try again.");
        else setVoiceNotice("Live transcription connection lost. Reconnecting…");
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
    setLiveRetries([]);
    batchLoopRef.current = null;
    acquisitionPendingRef.current = true;
    // Explicit mic-on intent; a Mute click during acquisition overwrites it.
    mutedRef.current = false;
    const generation = ++recordingGenerationRef.current;
    bridgeRetargetRef.current = null;
    try {
      const configResponse = await fetch(
        `/api/v1/interviews/invitations/${encodeURIComponent(token)}/asr/config`,
      );
      if (generation !== recordingGenerationRef.current || ended) return;
      // Never acquire the microphone when no ASR provider is configured: the
      // failure must be shown while typed answers remain available.
      if (!configResponse.ok) {
        const configBody = (await configResponse.json().catch(() => null)) as { error?: { message?: string } } | null;
        setVoiceNotice(configBody?.error?.message ?? "Speech-to-text is not configured. You can type your answer instead.");
        mutedRef.current = true;
        return;
      }
      const config = (await configResponse.json().catch(() => null)) as { mode?: string } | null;
      if (config?.mode !== "stream" && config?.mode !== "batch") {
        setVoiceNotice("Speech-to-text is not available. You can type your answer instead.");
        mutedRef.current = true;
        return;
      }
      if (generation !== recordingGenerationRef.current || ended) return;

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

      if (config.mode === "stream") {
        if (!(await openLiveBridge())) {
          // A bridge failure must stay on the configured streaming provider:
          // never silently switch to batch transcription. The mic is released
          // and the failure is surfaced for an explicit retry.
          setVoiceNotice(bridgeErrorRef.current ?? "Live transcription could not start. You can type your answer instead.");
          stream.getTracks().forEach((track) => stopCaptureTrack(track));
          if (streamRef.current === stream) streamRef.current = null;
          mutedRef.current = true;
          return;
        }
        if (generation !== recordingGenerationRef.current || ended) {
          stream.getTracks().forEach((track) => stopCaptureTrack(track));
          if (streamRef.current === stream) streamRef.current = null;
          return;
        }
        // Capture this bridge's id once and serialize PCM posts per stream:
        // each window is sent only after the previous one completes, so the
        // server's arrival order matches capture order. An older bridge can
        // never have its windows retargeted to a newer stream id, except by an
        // explicit reconnect of this same bridge.
        let activeId = streamIdRef.current;
        if (!activeId) {
          stream.getTracks().forEach((track) => stopCaptureTrack(track));
          if (streamRef.current === stream) streamRef.current = null;
          return;
        }
        const retarget = (newId: string) => { activeId = newId; };
        bridgeRetargetRef.current = retarget;
        let relayStopped = false;
        let pcmChain: Promise<unknown> = Promise.resolve();
        const stopRelay = startPcmRelay(stream, (base64) => {
          if (relayStopped) return;
          pcmChain = pcmChain.then(() => {
            // Queued windows must still drain after a mute click so the final
            // audio reaches the provider before DELETE finalizes the stream.
            return fetch(`/api/v1/interviews/invitations/${encodeURIComponent(token)}/asr/stream`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ streamId: activeId, audioBase64: base64 }),
            }).catch(() => undefined);
          }).catch(() => undefined);
        });
        (stream as MediaStream & { __stopRelay?: () => Promise<void> }).__stopRelay = async () => {
          relayStopped = true;
          if (bridgeRetargetRef.current === retarget) bridgeRetargetRef.current = null;
          stopRelay();
          // Wait for already-queued PCM posts, but accept no new audio.
          await pcmChain;
        };
        if (mutedRef.current) {
          // A Mute click arrived while the bridge was opening: honour it.
          void finalizeLiveBridge();
          return;
        }
        streamModeRef.current = true;
        setMuted(false);
        return;
      }
      // A generation change or end/unmount must not resume batch acquisition.
      if (generation !== recordingGenerationRef.current || ended) {
        stream.getTracks().forEach((track) => stopCaptureTrack(track));
        if (streamRef.current === stream) streamRef.current = null;
        return;
      }

      // Each window is a complete recording: stop the recorder at the boundary,
      // submit the finished file, then restart on the same stream. Timeslice
      // blobs are not guaranteed to be independently decodable.
      let pending: Blob[] = [];
      let finished = false;
      let forceCancel = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const releaseStream = () => {
        stream.getTracks().forEach((track) => stopCaptureTrack(track));
        if (streamRef.current === stream) streamRef.current = null;
      };
      const flushPending = (mimeType: string) => {
        if (pending.length === 0) return;
        const mime = mimeType || "audio/webm";
        const window = new Blob(pending, { type: mime });
        pending = [];
        void submitWindow(window, mime);
      };
      const stopLoop = (finalFlush: boolean) => {
        if (finished) return;
        finished = true;
        forceCancel = !finalFlush;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        batchLoopRef.current = null;
        const recorder = recorderRef.current;
        if (recorder && recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            // Already stopped while the tracks were released.
          }
        } else {
          releaseStream();
        }
      };
      const scheduleNext = () => {
        if (finished || generation !== recordingGenerationRef.current || ended) return;
        timer = setTimeout(() => {
          timer = null;
          const recorder = recorderRef.current;
          if (recorder && recorder.state === "recording") {
            try {
              recorder.stop();
            } catch {
              // A mic-off/end already stopped it.
            }
          }
        }, 4000);
      };
      const createRecorder = (): MediaRecorder => {
        const recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) pending.push(event.data);
        };
        recorder.onstop = () => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          const cancel = forceCancel || generation !== recordingGenerationRef.current
            || ended || cancelledRecorderRef.current === recorder;
          if (cancelledRecorderRef.current === recorder) cancelledRecorderRef.current = null;
          if (!cancel) flushPending(recorder.mimeType);
          if (recorderRef.current === recorder) recorderRef.current = null;
          if (cancel || finished) {
            releaseStream();
            return;
          }
          try {
            const next = createRecorder();
            recorderRef.current = next;
            next.start();
            scheduleNext();
          } catch {
            // Recorder could not be recreated; do not keep the mic live.
            releaseStream();
          }
        };
        return recorder;
      };
      batchLoopRef.current = { stop: stopLoop };
      try {
        const recorder = createRecorder();
        recorderRef.current = recorder;
        recorder.start();
        scheduleNext();
      } catch (error) {
        batchLoopRef.current = null;
        releaseStream();
        throw error;
      }
      // A Mute click during recorder setup wins over this activation.
      if (!mutedRef.current) setMuted(false);
      else batchLoopRef.current?.stop(false);
    } catch {
      // A failure anywhere after acquisition (including PCM relay setup) must
      // tear down the bridge and the tracks, not merely show a notice.
      const stream = streamRef.current;
      void (stream as (MediaStream & { __stopRelay?: () => Promise<void> }) | null)?.__stopRelay?.();
      if (streamModeRef.current) {
        const id = streamIdRef.current;
        if (id) {
          void fetch(`/api/v1/interviews/invitations/${encodeURIComponent(token)}/asr/stream?streamId=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
        }
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        streamModeRef.current = false;
        streamIdRef.current = null;
        bridgeRetargetRef.current = null;
      }
      stream?.getTracks().forEach((track) => stopCaptureTrack(track));
      streamRef.current = null;
      setMuted(true);
      mutedRef.current = true;
      setVoiceNotice("Microphone access was not granted. You can type your answer instead.");
    } finally {
      acquisitionPendingRef.current = false;
    }
  }

  /**
   * Mic-off on the live bridge: stop capture, but keep SSE open while DELETE
   * finalizes so the provider's last transcript can still reach the UI. The
   * server ends the stream on its terminal event; a bounded wait covers a
   * provider that never reports completion.
   */
  async function finalizeLiveBridge() {
    const id = streamIdRef.current;
    const es = eventSourceRef.current;
    const stream = streamRef.current;
    // Stop generating PCM but let queued posts reach the server before DELETE
    // finalizes the stream; a stalled relay cannot block mic-off indefinitely.
    await withDeadline(
      (stream as (MediaStream & { __stopRelay?: () => Promise<void> }) | null)?.__stopRelay?.(),
      2500,
    );
    streamModeRef.current = false;
    streamIdRef.current = null;
    bridgeRetargetRef.current = null;
    if (id) {
      await withDeadline(
        fetch(`/api/v1/interviews/invitations/${encodeURIComponent(token)}/asr/stream?streamId=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined),
        2500,
      );
    }
    if (es) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          es.removeEventListener("error", finish);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, 2500);
        es.addEventListener("error", finish);
      });
    }
    es?.close();
    if (eventSourceRef.current === es) eventSourceRef.current = null;
    // Stop and clear only this capture; a mic-on during the finalize wait may
    // already have installed a newer stream.
    stream?.getTracks().forEach((track) => stopCaptureTrack(track));
    if (streamRef.current === stream) streamRef.current = null;
  }

  function toggleMic() {
    if (!muted) {
      // Explicit mic-off intent: the ref stays authoritative while the bridge
      // drains and the tracks are released asynchronously.
      mutedRef.current = true;
      setMuted(true);
      if (streamModeRef.current) {
        void finalizeLiveBridge();
      } else if (batchLoopRef.current) {
        // onstop flushes the final complete window before releasing the tracks.
        batchLoopRef.current.stop(true);
      } else {
        recorderRef.current?.stop();
      }
      streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = false; });
      return;
    }
    // Explicit mic-on intent; startMic checks it again after every await.
    mutedRef.current = false;
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
              // result and the typed retry key for the previous draft.
              draftRevisionRef.current += 1;
              pendingKeyRef.current = null;
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
      {!ended ? liveRetries.map((retry) => (
        <button
          key={retry.key}
          type="button"
          className="btn-ghost self-center"
          onClick={() => {
            setLiveRetries((current) => current.filter((item) => item.key !== retry.key));
            void submitLiveTranscript(retry.text, retry.generation, retry.key);
          }}
        >
          Retry answer
        </button>
      )) : null}
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
