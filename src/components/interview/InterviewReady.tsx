"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarClock, Loader2, Play } from "lucide-react";

/**
 * Standalone "interview is ready" page shown AFTER the generation call has
 * finished and the details were confirmed. A dedicated route (not an inline
 * panel) gives the decision the space it deserves and keeps the voice room
 * separate from the scheduling choice.
 */
export function InterviewReady({
  sessionId,
  role,
  category,
  mode,
  questions,
  topics,
  level,
  invitationPath,
}: {
  sessionId: string;
  role: string;
  category: string;
  mode: string;
  questions: number | null;
  topics: string[];
  level: string | null;
  invitationPath: string;
}) {
  const router = useRouter();
  const [scheduling, setScheduling] = useState(false);
  const [localTime, setLocalTime] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveSchedule() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/interviews/${encodeURIComponent(sessionId)}/schedule`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scheduledAt: new Date(localTime).toISOString() }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(body?.error?.message ?? "Could not save the schedule.");
      }
      router.push("/dashboard");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the schedule.");
      setPending(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
      <button type="button" onClick={() => router.push("/dashboard")} className="text-sm text-ink-muted underline underline-offset-4">
        Back to dashboard
      </button>

      <div className="mt-6 rounded-3xl border border-line bg-surface p-6 sm:p-8">
        <p className="text-xs uppercase tracking-wide text-emerald-400">Interview generated</p>
        <h1 className="mt-2 font-display text-2xl font-semibold text-ink">{role} · {category}</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Your mock interview is ready. Review the details below, then choose what to do next.
        </p>

        <dl className="mt-6 grid gap-4 sm:grid-cols-2">
          <div><dt className="text-xs uppercase tracking-wide text-ink-muted">Target role</dt><dd className="mt-1 text-sm text-ink">{role}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-ink-muted">Interview type</dt><dd className="mt-1 text-sm text-ink">{category}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-ink-muted">Experience level</dt><dd className="mt-1 text-sm text-ink">{level || "Not specified"}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-ink-muted">Questions</dt><dd className="mt-1 text-sm text-ink">{questions ?? "Not specified"}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-ink-muted">Evaluation mode</dt><dd className="mt-1 text-sm text-ink">{mode}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs uppercase tracking-wide text-ink-muted">Topics</dt><dd className="mt-1 text-sm text-ink">{topics.length ? topics.join(", ") : "Not specified"}</dd></div>
        </dl>

        <div className="mt-8 border-t border-line pt-6">
          <h2 className="text-sm font-semibold text-ink">What would you like to do?</h2>
          <p className="mt-1 text-xs text-ink-muted">
            You can edit these details or reschedule from your dashboard any time before you start.
          </p>
          {!scheduling ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <button type="button" onClick={() => router.push(`${invitationPath}/waiting`)} className="btn-primary justify-center">
                <Play className="h-4 w-4" aria-hidden /> Start now
              </button>
              <button type="button" onClick={() => setScheduling(true)} className="btn-ghost justify-center">
                <CalendarClock className="h-4 w-4" aria-hidden /> Schedule for later
              </button>
              <button type="button" onClick={() => router.push("/dashboard")} className="btn-ghost justify-center">
                Leave for now and set later
              </button>
            </div>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs uppercase tracking-wide text-ink-muted">Date and time</span>
                <input
                  type="datetime-local"
                  value={localTime}
                  onChange={(event) => setLocalTime(event.target.value)}
                  className="h-11 rounded-full border border-line bg-raised px-4 text-sm text-ink" />
              </label>
              {error ? <p className="text-sm text-red-400" role="alert">{error}</p> : null}
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void saveSchedule()} disabled={pending || !localTime} className="btn-primary">
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Save and return to dashboard
                </button>
                <button type="button" onClick={() => { setScheduling(false); setError(null); }} className="btn-ghost">
                  <ArrowLeft className="h-4 w-4" aria-hidden /> Back
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
