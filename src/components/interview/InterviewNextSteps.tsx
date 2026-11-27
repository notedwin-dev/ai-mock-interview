"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarClock, Loader2, Play } from "lucide-react";

/**
 * Owner-controlled next step after a generated interview is confirmed
 * (owner decision 2026-11-22). The candidate may start now, choose a time, or
 * leave and set it later from the dashboard. Nothing is forced on them and the
 * interview never starts until they explicitly join the waiting room.
 */
export function InterviewNextSteps({
  invitationPath,
  sessionId,
}: {
  invitationPath: string;
  sessionId: string;
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
      const scheduledAt = new Date(localTime).toISOString();
      const response = await fetch(
        `/api/v1/interviews/${encodeURIComponent(sessionId)}/schedule`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scheduledAt }),
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

  function leaveForNow() {
    router.push("/dashboard");
  }

  return (
    <section className="rounded-3xl border border-line bg-surface p-6">
      <h2 className="font-display text-xl font-semibold text-ink">Your interview is ready</h2>
      <p className="mt-2 text-sm text-ink-muted">
        Start now, choose a time, or leave it for later. You can edit the details or reschedule
        from your dashboard any time before you start.
      </p>

      {!scheduling ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => router.push(`${invitationPath}/waiting`)}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-emerald-400 px-5 text-sm font-semibold text-emerald-950 transition-colors hover:bg-emerald-300">
            <Play className="h-4 w-4" aria-hidden /> Start now
          </button>
          <button
            type="button"
            onClick={() => setScheduling(true)}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-line px-5 text-sm font-semibold text-ink transition-colors hover:border-ink-muted">
            <CalendarClock className="h-4 w-4" aria-hidden /> Schedule for later
          </button>
          <button
            type="button"
            onClick={leaveForNow}
            className="inline-flex h-11 items-center justify-center rounded-full border border-line px-5 text-sm text-ink-soft transition-colors hover:border-ink-muted hover:text-ink">
            Leave for now and set later
          </button>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-3">
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
            <button
              type="button"
              onClick={() => void saveSchedule()}
              disabled={pending || !localTime}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-emerald-400 px-6 text-sm font-semibold text-emerald-950 disabled:opacity-60">
              {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Save and return to dashboard
            </button>
            <button
              type="button"
              onClick={() => { setScheduling(false); setError(null); }}
              className="inline-flex h-11 items-center gap-2 rounded-full border border-line px-5 text-sm text-ink-soft">
              <ArrowLeft className="h-4 w-4" aria-hidden /> Back
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
