"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2, MessageSquare, Mic, MicOff, Send, X } from "lucide-react";
import type { InvitationView } from "@/lib/interview/invitations";
import type { TranscriptEntry } from "@/lib/interview/room";

/**
 * Live interview room (FR-INTERVIEW-003/004, TT-8 re-layer): two participant
 * panels with AI states and a chronological transcript in an independently
 * openable OVERLAY (never a sidebar). All turns go through the token-scoped
 * API; the camera is never an AI input (ADR-005).
 */
const PRIMARY =
  "inline-flex h-11 items-center gap-2 rounded-full bg-emerald-400 px-5 text-sm font-semibold text-emerald-950 outline-none transition-all hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-emerald-400";
const GHOST =
  "inline-flex h-10 items-center gap-2 rounded-full border border-line px-4 text-sm text-ink-soft outline-none transition-colors hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-emerald-400";

export function InterviewRoom({ token, interview }: { token: string; interview: InvitationView }) {
  const [messages, setMessages] = useState<TranscriptEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<"listening" | "thinking" | "speaking">("listening");
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

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
      if (body.audioBase64) {
        try {
          void new Audio(`data:audio/mp3;base64,${body.audioBase64}`).play().catch(() => undefined);
        } catch {
          // Browser blocked autoplay — the text reply is still visible.
        }
      }
      setState(body.endCall ? "listening" : "speaking");
      if (body.endCall) setEnded(true);
    } catch {
      setError("The request could not reach the server.");
      setState("listening");
    }
  }

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  async function submitAudio(blob: Blob, recorderMime: string) {
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
      const body = (await response.json()) as { text?: string; error?: { message: string } };
      if (!response.ok) {
        setVoiceNotice(body.error?.message ?? "The recording could not be transcribed.");
        return;
      }
      // The transcript goes into the input for review — nothing is sent until
      // the candidate explicitly presses Send.
      setDraft(body.text ?? "");
      setVoiceNotice("Voice transcribed — review the text, then press Send.");
    } catch {
      setVoiceNotice("The recording could not be transcribed.");
    }
  }

  async function startRecording() {
    setVoiceNotice(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        void submitAudio(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }), recorder.mimeType);
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecording(false);
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setVoiceNotice("Microphone access was not granted. You can type your answer instead.");
    }
  }

  const lastInterviewer = [...messages].reverse().find((m) => m.speakerType === "interviewer");

  return (
    <div className="flex min-h-[calc(100vh-2rem)] flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-5 py-3">
        <div>
          <h1 className="font-display text-lg font-semibold text-ink">Mock interview · {interview.jobRole}</h1>
          <p className="text-xs text-ink-muted">{interview.categoryNameSnapshot} · {interview.evaluationMode} mode</p>
        </div>
        <button type="button" onClick={() => setOverlayOpen((open) => !open)} className={GHOST}>
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
          <p className="mt-1 text-xs text-ink-muted">{muted ? "microphone muted" : "microphone ready"}</p>
          <button type="button" onClick={() => setMuted((value) => !value)} className={`${GHOST} mt-4`}>
            {muted ? <MicOff className="h-4 w-4" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
            {muted ? "Unmute" : "Mute"}
          </button>
          <p className="mt-3 text-xs text-ink-muted">Camera and microphone are never used as AI input.</p>
        </section>
      </div>

      {ended ? (
        <div className="rounded-2xl border border-emerald-400/40 bg-surface p-5 text-sm text-ink">
          The interview has ended. Your transcript and report will be available in your history.
        </div>
      ) : (
        <form onSubmit={(event) => void send(event)} className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4 sm:flex-row sm:items-center">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="h-11 flex-1 rounded-full border border-line bg-raised px-5 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-emerald-400/70"
            placeholder="Type your answer…"
            maxLength={5000}
            aria-label="Your interview answer"
            disabled={state === "thinking"}
          />
          <button
            type="button"
            onClick={() => (recording ? recorderRef.current?.stop() : void startRecording())}
            className={GHOST}
            aria-label={recording ? "Stop recording" : "Record answer"}
          >
            {recording ? (
              <><span aria-hidden className="h-2.5 w-2.5 rounded-full bg-red-400" /> Stop recording</>
            ) : (
              <><Mic className="h-4 w-4" aria-hidden /> Record answer</>
            )}
          </button>
          <button type="submit" disabled={!draft.trim() || state === "thinking"} className={PRIMARY}>
            {state === "thinking" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
            Send
          </button>
        </form>
      )}
      {voiceNotice ? <p className="text-sm text-amber-300" role="status">{voiceNotice}</p> : null}
      {error ? <p className="text-sm text-red-400" role="alert">{error}</p> : null}

      {overlayOpen ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60" role="dialog" aria-label="Conversation transcript">
          <button type="button" aria-label="Close conversation" onClick={() => setOverlayOpen(false)} className="absolute inset-0 cursor-default" />
          <div className="relative z-10 flex h-full w-full max-w-md flex-col gap-3 overflow-y-auto border-l border-line bg-surface p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold text-ink">Conversation</h2>
              <button type="button" onClick={() => setOverlayOpen(false)} className={GHOST}>Close</button>
            </div>
            {messages.length === 0 ? (
              <p className="text-sm text-ink-muted">No turns yet. Introduce yourself to begin.</p>
            ) : (
              messages.map((message) => (
                <div key={message.sequenceNumber} className={`max-w-[90%] rounded-2xl px-4 py-2 text-sm ${message.speakerType === "candidate" ? "self-end bg-emerald-400/15 text-ink" : "self-start bg-raised text-ink-soft"}`}>
                  <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-ink-muted">
                    {message.speakerType === "candidate" ? "You" : "AI"} · {message.messageKind.replace(/_/g, " ")}
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
