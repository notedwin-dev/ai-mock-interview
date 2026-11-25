"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2, MessageSquare, Mic, MicOff, Send, X } from "lucide-react";
import { EndInterviewButton } from "@/components/interview/EndInterviewButton";
import { useOverlayFocusTrap } from "@/components/interview/use-overlay-focus-trap";
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
  const [muted, setMuted] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  /**
   * Overlay dialog behaviour (M8): focus moves into the panel when it opens,
   * Escape closes it, and focus returns to the control that opened it. Shared
   * implementation in use-overlay-focus-trap (TT-8 review dedup).
   */
  useOverlayFocusTrap(overlayOpen, overlayRef, () => setOverlayOpen(false));


  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`/api/v1/interviews/invitations/${encodeURIComponent(token)}/turns`, { cache: "no-store" });
        if (response.ok && active) {
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

  async function send(event: FormEvent) {
    event.preventDefault();
    const contentText = draft.trim();
    if (!contentText || state === "thinking") return;
    setDraft("");
    setError(null);
    setState("thinking");
    try {
      const response = await fetch(`/api/v1/interviews/invitations/${encodeURIComponent(token)}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentText, idempotencyKey: crypto.randomUUID() }),
      });
      const body = (await response.json()) as {
        messages?: TranscriptEntry[];
        error?: { message: string };
        endCall?: boolean;
        audioBase64?: string | null;
      };
      if (!response.ok) {
        setError(body.error?.message ?? "The interviewer could not respond.");
        setState("listening");
        return;
      }
      setMessages(body.messages ?? []);
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
      setState(body.endCall || !audioPlaying ? "listening" : "speaking");
      if (body.endCall) setEnded(true);
    } catch {
      setError("The request could not reach the server.");
      setState("listening");
    }
  }

  useEffect(() => () => {
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  /**
   * Continuous transcription (owner decision 2026-11-25): while the microphone
   * is on, AIMIS transcribes what the candidate says. No push-to-talk, no
   * "record then review" step. Each audio window is sent to the configured ASR
   * provider and any recognised speech becomes a candidate turn, which also
   * prompts the interviewer to respond. Turning the microphone off stops the
   * capture and flushes the final window.
   */
  async function submitWindow(blob: Blob, recorderMime: string) {
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
      const asrBody = (await asr.json().catch(() => null)) as { text?: string; error?: { message: string } } | null;
      if (!asr.ok || !asrBody?.text?.trim()) return; // silence is normal between turns
      const contentText = asrBody.text.trim();
      const response = await fetch(
        `/api/v1/interviews/invitations/${encodeURIComponent(token)}/turns`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentText, idempotencyKey: `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }),
        },
      );
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
      setMessages(body.messages ?? []);
      if (body.audioBase64) {
        try {
          const audio = new Audio(`data:audio/mp3;base64,${body.audioBase64}`);
          void audio.play().catch(() => undefined);
        } catch {
          // Autoplay may be blocked; the transcript is still rendered.
        }
      }
      if (body.endCall) setEnded(true);
    } catch {
      setVoiceNotice("Transcription failed. Check your connection and try turning the microphone on again.");
    }
  }

  const streamModeRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const streamIdRef = useRef<string | null>(null);

  /** Feed a live-transcription result into the interview as a candidate turn. */
  async function submitLiveTranscript(text: string) {
    const contentText = text.trim();
    if (!contentText) return;
    const response = await fetch(
      `/api/v1/interviews/invitations/${encodeURIComponent(token)}/turns`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentText, idempotencyKey: `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }),
      },
    );
    const body = (await response.json().catch(() => null)) as {
      messages?: TranscriptEntry[];
      endCall?: boolean;
      audioBase64?: string | null;
    } | null;
    if (!response.ok || !body) return;
    setMessages(body.messages ?? []);
    if (body.audioBase64) {
      try { void new Audio(`data:audio/mp3;base64,${body.audioBase64}`).play().catch(() => undefined); } catch { /* text still shown */ }
    }
    if (body.endCall) setEnded(true);
  }

  /** Open the server-side Gemini Live transcription bridge for this mic session. */
  async function openLiveBridge(): Promise<boolean> {
    const es = new EventSource(
      `/api/v1/interviews/invitations/${encodeURIComponent(token)}/asr/stream`,
    );
    eventSourceRef.current = es;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 12000);
      es.onmessage = (event) => {
        const data = JSON.parse(event.data) as { type: string; streamId?: string; text?: string; message?: string };
        if (data.type === "ready" && data.streamId) {
          streamIdRef.current = data.streamId;
          streamModeRef.current = true;
          clearTimeout(timer);
          resolve(true);
        } else if (data.type === "transcript" && data.text) {
          void submitLiveTranscript(data.text);
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
    setVoiceNotice(null);
    try {
      const configResponse = await fetch(
        `/api/v1/interviews/invitations/${encodeURIComponent(token)}/asr/config`,
      );
      const config = configResponse.ok
        ? (await configResponse.json()) as { mode?: string }
        : { mode: "batch" };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      if (config.mode === "stream" && (await openLiveBridge())) {
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

      const recorder = new MediaRecorder(stream);
      let pending: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) pending.push(event.data);
        if (pending.length === 0) return;
        const window = new Blob(pending, { type: recorder.mimeType || "audio/webm" });
        pending = [];
        void submitWindow(window, recorder.mimeType);
      };
      recorder.onstop = () => {
        if (pending.length > 0) {
          const window = new Blob(pending, { type: recorder.mimeType || "audio/webm" });
          pending = [];
          void submitWindow(window, recorder.mimeType);
        }
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
      };
      recorderRef.current = recorder;
      // A window every 4 s keeps transcription near-real-time without a
      // streaming ASR endpoint. Each call is idempotent-keyed.
      recorder.start(4000);
      setMuted(false);
    } catch {
      setVoiceNotice("Microphone access was not granted. You can type your answer instead.");
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
            onChange={(event) => setDraft(event.target.value)}
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
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60" role="dialog" aria-modal="true" aria-labelledby="conversation-heading">
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
