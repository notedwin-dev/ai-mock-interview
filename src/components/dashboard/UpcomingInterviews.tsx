"use client";

import { useSyncExternalStore, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, Loader2, Play } from "lucide-react";

/**
 * Candidate-owned interviews that have not started yet (FR-SETUP-007/008).
 * Details remain editable and the planned time can be set or changed until
 * the candidate joins; the time is informational and never starts the call.
 */
export interface UpcomingSession {
  sessionId: string;
  jobRole: string;
  categoryNameSnapshot: string;
  evaluationMode: string;
  scheduledAt: string | null;
  invitationPath: string | null;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

// Server and browser must agree on the first render; only then switch to the
// browser's local zone so the planned time is shown in the candidate's time.
const STABLE_DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

// getServerSnapshot is used for the server render and the first client render;
// getSnapshot switches to the browser-local value only after hydration.
const NOOP_SUBSCRIBE = () => () => {};
function useHydrated() {
  return useSyncExternalStore(
    NOOP_SUBSCRIBE,
    () => true,
    () => false,
  );
}

export function UpcomingInterviews({ sessions }: { sessions: UpcomingSession[] }) {
  const router = useRouter();
  const [active, setActive] = useState<string | null>(null);
  const [localTime, setLocalTime] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hydrated = useHydrated();

  if (sessions.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-line bg-surface/50 px-6 py-10 text-center">
        <p className="text-sm text-ink-muted">
          No interviews waiting. Generate one to set up your next practice round.
        </p>
      </div>
    );
  }

  async function save(sessionId: string) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/interviews/${encodeURIComponent(sessionId)}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledAt: new Date(localTime).toISOString() }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(body?.error?.message ?? "Could not save the schedule.");
      }
      // Only the editor that started this request is allowed to close; another
      // card's editor (and its input) must survive a late completion.
      setActive((current) => (current === sessionId ? null : current));
      setLocalTime("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the schedule.");
    } finally {
      setPending(false);
    }
  }

  async function clear(sessionId: string) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/interviews/${encodeURIComponent(sessionId)}/schedule`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Could not clear the schedule.");
      setActive((current) => (current === sessionId ? null : current));
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not clear the schedule.");
    } finally {
      setPending(false);
    }
  }

  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {sessions.map((session) => {
        const editing = active === session.sessionId;
        return (
          <li
            key={session.sessionId}
            className="flex h-full flex-col gap-4 rounded-2xl border border-line bg-surface p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate font-display text-lg font-semibold text-ink">
                  {session.jobRole}
                </h3>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {session.categoryNameSnapshot} · {session.evaluationMode} evaluation
                </p>
              </div>
              <span className="shrink-0 rounded-full border border-line bg-raised px-3 py-1 text-xs font-medium text-ink-soft">
                {session.scheduledAt ? "Scheduled" : "Not scheduled"}
              </span>
            </div>

            <p className="flex items-center gap-1.5 text-xs text-ink-muted">
              <CalendarClock className="h-3.5 w-3.5" aria-hidden />
              {session.scheduledAt
                ? `Planned for ${(hydrated ? DATE_FORMAT : STABLE_DATE_FORMAT).format(new Date(session.scheduledAt))}`
                : "Set a time whenever you are ready"}
            </p>

            {editing ? (
              <div className="flex flex-col gap-2">
                <input
                  type="datetime-local"
                  aria-label="Interview date and time"
                  value={localTime}
                  onChange={(event) => setLocalTime(event.target.value)}
                  className="h-10 rounded-full border border-line bg-raised px-4 text-sm text-ink" />
                {error ? <p className="text-xs text-red-400" role="alert">{error}</p> : null}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void save(session.sessionId)}
                    disabled={pending || !localTime}
                    className="inline-flex h-9 items-center gap-2 rounded-full bg-emerald-400 px-4 text-xs font-semibold text-emerald-950 disabled:opacity-60">
                    {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                    Save
                  </button>
                  {session.scheduledAt ? (
                    <button
                      type="button"
                      onClick={() => void clear(session.sessionId)}
                      disabled={pending}
                      className="inline-flex h-9 items-center rounded-full border border-line px-4 text-xs text-ink-soft">
                      Clear time
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => { setActive(null); setError(null); }}
                    className="inline-flex h-9 items-center rounded-full border border-line px-4 text-xs text-ink-soft">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-auto flex flex-wrap gap-2 border-t border-line pt-4">
                {session.invitationPath ? (
                  <Link
                    href={`${session.invitationPath}/waiting`}
                    className="inline-flex h-9 items-center gap-2 rounded-full bg-emerald-400 px-4 text-xs font-semibold text-emerald-950 transition-colors hover:bg-emerald-300">
                    <Play className="h-3.5 w-3.5" aria-hidden /> Start now
                  </Link>
                ) : (
                  <Link
                    href={`/dashboard/interview/${session.sessionId}`}
                    className="inline-flex h-9 items-center rounded-full bg-emerald-400 px-4 text-xs font-semibold text-emerald-950">
                    Open room
                  </Link>
                )}
                <Link
                  href={`/dashboard/interview/${session.sessionId}/edit`}
                  className="inline-flex h-9 items-center rounded-full border border-line px-4 text-xs font-semibold text-ink-soft transition-colors hover:border-ink-muted hover:text-ink">
                  Edit details
                </Link>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => { setActive(session.sessionId); setError(null); }}
                  className="inline-flex h-9 items-center rounded-full border border-line px-4 text-xs font-semibold text-ink-soft transition-colors hover:border-ink-muted hover:text-ink disabled:opacity-60">
                  {session.scheduledAt ? "Reschedule" : "Schedule"}
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
