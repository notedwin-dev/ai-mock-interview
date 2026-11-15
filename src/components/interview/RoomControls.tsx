"use client";

import { useState, type FormEvent } from "react";
import { typedTurnSchema } from "@/lib/interview/validation";
import type { SessionSummary, TranscriptMessage } from "@/lib/interview/service";

/**
 * Meeting-room controls for the typed-interview path (FR-INTERVIEW-003/004/
 * 011): explicit start, idempotent typed turns (NFR-REL-002) and candidate
 * end. State always comes from the backend transcript API — this component
 * renders it and never invents interviewer turns locally (the AI interviewer
 * itself is the M2 orchestrator, backlog slices 9-10).
 */

const SESSION_STATUS_WORDS: Record<string, { word: string; dot: string; text: string }> = {
  created: { word: "Set up", dot: "bg-ink-muted/60", text: "text-ink-muted" },
  active: {
    word: "In progress",
    dot: "bg-emerald-600 dark:bg-emerald-400",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  completed: { word: "Completed", dot: "bg-ink-soft", text: "text-ink-soft" },
  failed: {
    word: "Failed",
    dot: "bg-red-600 dark:bg-red-400",
    text: "text-red-700 dark:text-red-300",
  },
};

const fieldClassName =
  "h-10 rounded-lg border border-line bg-card px-3 text-sm text-ink outline-none transition-colors focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 dark:focus:border-emerald-400 dark:focus:ring-emerald-400/20";

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

  return (
    <div className="mt-6 flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
            Interview room — {session.jobRole}
          </h1>
          <p className="mt-1 text-sm text-ink-soft">
            {session.categoryNameSnapshot} interview,{" "}
            {session.evaluationMode} evaluation,{" "}
            {session.runtimeMode === "preset_realtime"
              ? "pre-configured realtime agents"
              : "custom configuration"}{" "}
            runtime.
          </p>
        </div>
        <span
          className={`flex items-center gap-1.5 text-xs font-medium ${status.text}`}
        >
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
          {status.word}
        </span>
      </div>

      <div className="flex min-h-64 flex-col gap-4 rounded-xl border border-line bg-card p-5">
        <p className="text-xs font-medium text-ink-muted">Transcript</p>
        {messages.length === 0 ? (
          <p className="text-sm text-ink-soft">
            No messages yet. Start the interview, then submit your answers below.
          </p>
        ) : (
          <ol className="flex flex-col gap-4">
            {messages.map((message) => (
              <li key={message.messageId} className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-ink-muted">
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
      </div>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
          {error}
        </p>
      ) : null}

      {session.status === "created" ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => postLifecycle("start")}
          className="inline-flex h-10 cursor-pointer items-center justify-center rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white outline-none transition-all hover:bg-emerald-800 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-emerald-400 dark:focus-visible:ring-offset-paper"
        >
          {pending ? "Starting…" : "Start interview"}
        </button>
      ) : null}

      {session.status === "active" ? (
        <>
          <form onSubmit={submitTurn} className="flex items-center gap-3">
            <input
              type="text"
              value={answerText}
              onChange={(event) => setAnswerText(event.target.value)}
              placeholder="Type your answer…"
              disabled={pending}
              className={`${fieldClassName} flex-1`}
            />
            <button
              type="submit"
              disabled={pending || answerText.trim().length === 0}
              className="inline-flex h-10 cursor-pointer items-center rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white outline-none transition-all hover:bg-emerald-800 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-emerald-400 dark:focus-visible:ring-offset-paper"
            >
              {pending ? "Sending…" : "Send"}
            </button>
          </form>
          <p className="text-xs text-ink-muted">
            Voice and camera controls arrive with the realtime voice loop; your
            typed answers are recorded on the transcript now.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() => postLifecycle("end")}
            className="inline-flex h-10 cursor-pointer items-center justify-center rounded-lg border border-red-300 px-4 text-sm font-semibold text-red-700 outline-none transition-colors hover:bg-red-50 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/50 dark:focus-visible:ring-red-400"
          >
            {pending ? "Ending…" : "End interview"}
          </button>
        </>
      ) : null}

      {session.status === "completed" ? (
        <p className="text-sm text-ink-soft">
          This interview is completed. Your full transcript is saved for review.
        </p>
      ) : null}

      {session.status === "failed" ? (
        <p className="text-sm text-ink-soft">
          This interview failed
          {session.failureCode ? ` (${session.failureCode})` : ""}. You can start
          a new interview from the dashboard.
        </p>
      ) : null}
    </div>
  );
}
