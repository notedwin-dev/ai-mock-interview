"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Mic } from "lucide-react";
import { typedTurnSchema } from "@/lib/interview/validation";
import type { SessionSummary, TranscriptMessage } from "@/lib/interview/service";

/**
 * Meeting-room controls (FR-INTERVIEW-003/004/011), reference-design-adapted: a
 * two-participant layout (AI interviewer tile + candidate tile), the latest
 * interviewer question in a full-width bar, and the AIMIS additions the
 * reference lacks — a chronological conversation sidebar with speaker
 * attribution, AI thinking/listening states driven by real request state,
 * and an explicit mic control (disabled until the realtime voice loop, M2
 * slices 9–10, resolves ASR for the session). State always comes from the
 * backend transcript API — this component renders it and never invents
 * interviewer turns locally.
 */

const SESSION_STATUS_WORDS: Record<string, { word: string; dot: string; text: string }> = {
  created: { word: "Set up", dot: "bg-ink-muted/60", text: "text-ink-muted" },
  scheduled: {
    word: "Ready",
    dot: "bg-ink-muted/60",
    text: "text-ink-muted",
  },
  active: {
    word: "In progress",
    dot: "bg-emerald-400",
    text: "text-emerald-400",
  },
  completed: { word: "Completed", dot: "bg-ink-soft", text: "text-ink-soft" },
  failed: {
    word: "Failed",
    dot: "bg-red-400",
    text: "text-red-400",
  },
};

const FIELD_CLASS =
  "h-11 rounded-full border border-transparent bg-raised px-5 text-sm text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-emerald-400/70 focus:ring-2 focus:ring-emerald-400/20";

interface RoomControlsProps {
  initialSession: SessionSummary;
  initialMessages: TranscriptMessage[];
}

export function RoomControls({
  initialSession,
  initialMessages,
}: RoomControlsProps) {
  const [session, setSession] = useState(initialSession);
  const [messages, setMessages] = useState(initialMessages);
  const [answerText, setAnswerText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const conversationRef = useRef<HTMLOListElement>(null);

  // Keep the chronological sidebar pinned to the newest message.
  useEffect(() => {
    const list = conversationRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages.length]);

  async function refresh(sessionId: string): Promise<void> {
    const response = await fetch(`/api/v1/interviews/${sessionId}`);
    if (!response.ok) return;
    const body = (await response.json().catch(() => null)) as
      | { session?: SessionSummary; messages?: TranscriptMessage[] }
      | null;
    if (body?.session && Array.isArray(body.messages)) {
      setSession(body.session);
      setMessages(body.messages);
    }
  }

  async function postLifecycle(action: "start" | "end"): Promise<void> {
    if (action === "end" && !window.confirm("End this interview? You can review the transcript afterwards.")) {
      return;
    }
    setError(null);
    setPending(true);
    try {
      const response = await fetch(
        `/api/v1/interviews/${session.sessionId}/${action}`,
        { method: "POST" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "The request failed. Try again.");
      }
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
    await refresh(session.sessionId);
  }

  async function submitTurn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const parsed = typedTurnSchema.safeParse({
        contentText: answerText,
        inputMode: "text",
        // Client-generated key: a retried submit deduplicates server-side.
        idempotencyKey: crypto.randomUUID(),
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? "The response must not be empty.");
        return;
      }
      const response = await fetch(
        `/api/v1/interviews/${session.sessionId}/turns`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.data),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "The answer could not be saved. Try again.");
      } else {
        setAnswerText("");
      }
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
    await refresh(session.sessionId);
  }

  const status =
    SESSION_STATUS_WORDS[session.status] ?? SESSION_STATUS_WORDS.created;

  /**
   * AI interviewer state, from real request state only: thinking while a
   * turn is in flight, listening while the room waits on the candidate.
   * A "speaking" state arrives with the voice loop (TTS, slices 9–10).
   */
  const interviewerState = (() => {
    if (session.status === "failed") {
      return { word: "Failed", tone: "text-red-400", dot: "bg-red-400" };
    }
    if (session.status === "completed") {
      return { word: "Completed", tone: "text-ink-soft", dot: "bg-ink-soft" };
    }
    if (session.status === "created" || session.status === "scheduled") {
      return pending
        ? { word: "Connecting…", tone: "text-ink-muted", dot: "bg-ink-muted/60 animate-pulse" }
        : { word: "Ready", tone: "text-ink-muted", dot: "bg-ink-muted/60" };
    }
    return pending
      ? { word: "Thinking…", tone: "text-emerald-400", dot: "bg-emerald-400 animate-pulse" }
      : { word: "Listening", tone: "text-emerald-400", dot: "bg-emerald-400" };
  })();

  const latestInterviewerMessage = [...messages]
    .reverse()
    .find((message) => message.speakerType === "interviewer");

  const interviewerTileGlow =
    session.status === "active" ? "border-emerald-400/50" : "border-line";

  return (
    <div className="flex flex-col gap-6">
      {/* Title row: role, runtime summary, live status chip */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-400 text-emerald-950"
          >
            <Mic className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate font-display text-xl font-semibold tracking-tight text-ink sm:text-2xl">
              {session.jobRole}
            </h1>
            <p className="mt-0.5 truncate text-sm text-ink-muted">
              {session.categoryNameSnapshot} interview,{" "}
              {session.evaluationMode} evaluation,{" "}
              {session.runtimeMode === "preset_realtime"
                ? "pre-configured realtime agents"
                : "custom configuration"}{" "}
              runtime.
            </p>
          </div>
        </div>
        <span
          className={`flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-1.5 text-xs font-medium ${status.text}`}
        >
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
          {status.word}
        </span>
      </div>

      {/* Participants + conversation sidebar */}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_20rem]">
        <div
          className={`flex min-h-64 flex-col items-center justify-center gap-6 rounded-3xl border bg-raised p-8 text-center transition-colors ${interviewerTileGlow}`}
        >
          <span className="relative flex h-28 w-28 items-center justify-center rounded-full bg-emerald-400/10 ring-1 ring-emerald-400/30">
            <span className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-400/20">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-400 text-emerald-950">
                <Mic className="h-5 w-5" aria-hidden />
              </span>
            </span>
          </span>
          <div>
            <p className="text-lg font-semibold text-ink">AI Interviewer</p>
            <p
              className={`mt-1 flex items-center justify-center gap-1.5 text-xs font-medium ${interviewerState.tone}`}
            >
              <span
                aria-hidden
                className={`h-1.5 w-1.5 rounded-full ${interviewerState.dot}`}
              />
              {interviewerState.word}
            </p>
          </div>
        </div>

        <div className="flex min-h-64 flex-col items-center justify-center gap-6 rounded-3xl border border-line bg-surface p-8 text-center">
          <span
            aria-hidden
            className="flex h-20 w-20 items-center justify-center rounded-full border border-line bg-raised text-xl font-semibold text-ink-soft"
          >
            Y
          </span>
          <div>
            <p className="text-lg font-semibold text-ink">You</p>
            <p className="mt-1 text-xs text-ink-muted">
              Typed answers now; voice arrives with the realtime loop
            </p>
          </div>
        </div>

        <aside
          aria-label="Conversation"
          className="flex min-h-64 flex-col rounded-3xl border border-line bg-surface p-4 xl:max-h-[26rem]"
        >
          <p className="px-1 pb-2 text-xs font-medium text-ink-muted">
            Conversation
          </p>
          {messages.length === 0 ? (
            <p className="px-1 text-sm text-ink-muted">
              No messages yet. Start the interview, then submit your answers
              below.
            </p>
          ) : (
            <ol
              ref={conversationRef}
              className="flex flex-1 flex-col gap-3 overflow-y-auto px-1"
            >
              {messages.map((message) => (
                <li key={message.messageId} className="flex flex-col gap-0.5">
                  <span
                    className={`text-xs font-medium ${
                      message.speakerType === "interviewer"
                        ? "text-emerald-400"
                        : "text-ink-muted"
                    }`}
                  >
                    {message.speakerType === "interviewer" ? "Interviewer" : "You"}
                    {message.speakerType === "candidate" && message.candidateInputMode
                      ? ` (${message.candidateInputMode === "voice" ? "voice" : "typed"})`
                      : ""}
                  </span>
                  <p className="whitespace-pre-wrap text-sm text-ink">
                    {message.contentText}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>

      {/* Latest interviewer question */}
      {latestInterviewerMessage ? (
        <p className="rounded-2xl border border-line bg-raised px-6 py-4 text-center text-sm leading-relaxed text-ink">
          {latestInterviewerMessage.contentText}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
        >
          {error}
        </p>
      ) : null}

      {(session.status === "created" || session.status === "scheduled") ? (
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => postLifecycle("start")}
            className="btn-primary"
          >
            {pending ? "Starting…" : "Start interview"}
          </button>
          <p className="text-xs text-ink-muted">
            Starting is explicit; the room records only after you begin.
          </p>
        </div>
      ) : null}

      {session.status === "active" ? (
        <div className="flex flex-col gap-4">
          <form onSubmit={submitTurn} className="flex items-center gap-2">
            <button
              type="button"
              disabled
              title="Voice input arrives with the realtime voice loop"
              aria-label="Microphone (voice input not active yet)"
              className="inline-flex h-11 w-11 shrink-0 cursor-not-allowed items-center justify-center rounded-full border border-line bg-raised text-ink-muted"
            >
              <Mic className="h-4 w-4" aria-hidden />
            </button>
            <input
              type="text"
              value={answerText}
              onChange={(event) => setAnswerText(event.target.value)}
              placeholder="Type your answer…"
              disabled={pending}
              className={`${FIELD_CLASS} min-w-0 flex-1`}
            />
            <button
              type="submit"
              disabled={pending || answerText.trim().length === 0}
              className="btn-primary shrink-0"
            >
              {pending ? "Sending…" : "Send"}
            </button>
          </form>
          <div className="flex justify-center">
            <button
              type="button"
              disabled={pending}
              onClick={() => postLifecycle("end")}
              className="inline-flex h-11 cursor-pointer items-center justify-center rounded-full bg-red-500 px-6 text-sm font-semibold text-white outline-none transition-all hover:bg-red-400 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-red-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? "Ending…" : "End interview"}
            </button>
          </div>
        </div>
      ) : null}

      {session.status === "completed" ? (
        <p className="text-center text-sm text-ink-soft">
          This interview is completed. Your full transcript is saved for
          review; the written report arrives with the evaluation slice.
        </p>
      ) : null}

      {session.status === "failed" ? (
        <p className="text-center text-sm text-ink-soft">
          This interview failed
          {session.failureCode ? ` (${session.failureCode})` : ""}. You can
          start a new interview from the dashboard.
        </p>
      ) : null}
    </div>
  );
}
