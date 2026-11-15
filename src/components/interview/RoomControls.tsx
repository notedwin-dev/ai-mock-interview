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

const SESSION_STATUS_CLASSES: Record<string, string> = {
  created: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  completed: "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300",
};

const fieldClassName =
  "h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

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

  const statusClass =
    SESSION_STATUS_CLASSES[session.status] ?? SESSION_STATUS_CLASSES.created;

  return (
    <div className="mt-6 flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
            Interview room — {session.jobRole}
          </h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {session.categoryNameSnapshot} · evaluation: {session.evaluationMode} ·
            runtime: {session.runtimeMode === "preset_realtime"
              ? "Pre-configured Realtime Agents"
              : "Custom Configuration"}
          </p>
        </div>
        <span className={`rounded px-2 py-1 text-xs font-medium ${statusClass}`}>
          {session.status}
        </span>
      </div>

      <div className="flex min-h-64 flex-col gap-4 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Transcript
        </p>
        {messages.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No messages yet. Start the interview, then submit your answers below.
          </p>
        ) : (
          <ol className="flex flex-col gap-4">
            {messages.map((message) => (
              <li key={message.messageId} className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  {message.speakerType === "interviewer" ? "Interviewer" : "You"}
                  {message.speakerType === "candidate" && message.candidateInputMode
                    ? ` · ${message.candidateInputMode}`
                    : ""}
                </span>
                <p className="whitespace-pre-wrap text-sm text-zinc-900 dark:text-zinc-100">
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
          className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-zinc-50 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
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
              className="inline-flex h-10 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-zinc-50 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {pending ? "Sending…" : "Send"}
            </button>
          </form>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Voice and camera controls arrive with the realtime voice loop; your
            typed answers are recorded on the transcript now.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() => postLifecycle("end")}
            className="inline-flex h-10 items-center justify-center rounded-md border border-red-300 px-4 text-sm font-medium text-red-800 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/50"
          >
            {pending ? "Ending…" : "End interview"}
          </button>
        </>
      ) : null}

      {session.status === "completed" ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          This interview is completed. Your full transcript is saved for review.
        </p>
      ) : null}

      {session.status === "failed" ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          This interview failed
          {session.failureCode ? ` (${session.failureCode})` : ""}. You can start
          a new interview from the dashboard.
        </p>
      ) : null}
    </div>
  );
}
