import Link from "next/link";
import { Calendar } from "lucide-react";

/**
 * "Your past interviews": the candidate's real sessions as a restrained card
 * grid (PrepWise-adapted) — category chip, role, date, status always as
 * dot + word (never colour alone), and an explicit open action. No invented
 * scores or company branding; scores arrive with the evaluation slice (M3).
 * The whole card deep-links into the room. Server component.
 */

const STATUS_WORDS: Record<string, { word: string; dot: string; text: string }> = {
  created: {
    word: "Set up",
    dot: "bg-ink-muted/60",
    text: "text-ink-muted",
  },
  active: {
    word: "In progress",
    dot: "bg-emerald-400",
    text: "text-emerald-400",
  },
  completed: {
    word: "Completed",
    dot: "bg-ink-soft",
    text: "text-ink-soft",
  },
  failed: {
    word: "Failed",
    dot: "bg-red-400",
    text: "text-red-400",
  },
};

interface SessionLogProps {
  sessions: Array<{
    sessionId: string;
    jobRole: string;
    categoryNameSnapshot: string;
    evaluationMode: string;
    status: string;
    createdAt: Date;
  }>;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export function PastInterviews({ sessions }: SessionLogProps) {
  if (sessions.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-line bg-surface/50 px-6 py-10 text-center">
        <p className="text-sm text-ink-muted">
          No sessions yet — your first round is one click away.
        </p>
      </div>
    );
  }

  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {sessions.map((session) => {
        const status = STATUS_WORDS[session.status] ?? STATUS_WORDS.created;
        return (
          <li key={session.sessionId}>
            <Link
              href={`/dashboard/interview/${session.sessionId}`}
              className="group flex h-full flex-col gap-4 rounded-2xl border border-line bg-surface p-5 outline-none transition-colors hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              <div className="flex items-start justify-between gap-3">
                <span
                  aria-hidden
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-raised text-sm font-semibold text-ink-soft"
                >
                  {session.categoryNameSnapshot.slice(0, 1).toUpperCase()}
                </span>
                <span className="shrink-0 rounded-full border border-line bg-raised px-3 py-1 text-xs font-medium text-ink-soft">
                  {session.categoryNameSnapshot}
                </span>
              </div>

              <div className="min-w-0">
                <h3 className="truncate font-display text-lg font-semibold tracking-tight text-ink">
                  {session.jobRole}
                </h3>
                <p className="mt-0.5 text-xs capitalize text-ink-muted">
                  {session.evaluationMode} evaluation
                </p>
              </div>

              <div className="mt-auto flex items-center justify-between gap-3 border-t border-line pt-4">
                <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                  <Calendar className="h-3.5 w-3.5" aria-hidden />
                  {DATE_FORMAT.format(session.createdAt)}
                </span>
                <span
                  className={`flex items-center gap-1.5 text-xs font-medium ${status.text}`}
                >
                  <span
                    aria-hidden
                    className={`h-1.5 w-1.5 rounded-full ${status.dot}`}
                  />
                  {status.word}
                </span>
              </div>

              <span className="inline-flex h-9 w-fit cursor-pointer items-center justify-center rounded-full bg-emerald-400 px-4 text-xs font-semibold text-emerald-950 transition-colors group-hover:bg-emerald-300">
                Open room
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
