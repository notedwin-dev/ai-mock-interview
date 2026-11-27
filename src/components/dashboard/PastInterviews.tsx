import Link from "next/link";
import { Calendar } from "lucide-react";

/**
 * "Your past interviews": real sessions as a restrained card grid. Completed
 * sessions are presented as history (date/time taken plus feedback/retake
 * actions), never with live-room language or styling. Server component.
 */
const STATUS_WORDS: Record<string, { word: string; dot: string; text: string }> = {
  created: { word: "Set up", dot: "bg-ink-muted/60", text: "text-ink-muted" },
  active: { word: "In progress", dot: "bg-emerald-400", text: "text-emerald-400" },
  completed: { word: "Completed", dot: "bg-ink-soft", text: "text-ink-soft" },
  failed: { word: "Failed", dot: "bg-red-400", text: "text-red-400" },
};

interface SessionLogProps {
  sessions: Array<{
    sessionId: string;
    jobRole: string;
    categoryNameSnapshot: string;
    evaluationMode: string;
    status: string;
    scheduledAt: string | null;
    invitationPath: string | null;
    createdAt: Date;
    completedAt: Date | null;
  }>;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function PastInterviews({ sessions }: SessionLogProps) {
  if (sessions.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-line bg-surface/50 px-6 py-10 text-center">
        <p className="text-sm text-ink-muted">No sessions yet — your first round is one click away.</p>
      </div>
    );
  }

  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {sessions.map((session) => {
        const status = STATUS_WORDS[session.status] ?? STATUS_WORDS.created!;
        const completed = session.status === "completed";
        const timestamp = completed ? (session.completedAt ?? session.createdAt) : session.createdAt;
        return (
          <li
            key={session.sessionId}
            className={`flex h-full flex-col gap-4 rounded-2xl border bg-surface p-5 ${
              completed ? "border-line/60" : "border-line transition-colors hover:border-ink-muted"
            }`}>
            <div className="flex items-start justify-between gap-3">
              <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-raised text-sm font-semibold text-ink-soft">
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
              <p className="mt-0.5 text-xs text-ink-muted">
                {session.evaluationMode} evaluation
              </p>
            </div>

            <div className="mt-auto flex items-center justify-between gap-3 border-t border-line pt-4">
              <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                <Calendar className="h-3.5 w-3.5" aria-hidden />
                {completed ? "Taken " : ""}{DATE_FORMAT.format(timestamp)}
              </span>
              <span className={`flex items-center gap-1.5 text-xs font-medium ${status.text}`}>
                <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                {status.word}
              </span>
            </div>

            {completed ? (
              <div className="flex flex-wrap gap-2">
                <Link
                  href={`/dashboard/interview/${session.sessionId}/feedback`}
                  className="inline-flex h-9 items-center justify-center rounded-full bg-emerald-400 px-4 text-xs font-semibold text-emerald-950 transition-colors hover:bg-emerald-300">
                  View Feedback
                </Link>
                <Link
                  href={`/dashboard/interview/${session.sessionId}`}
                  className="inline-flex h-9 items-center justify-center rounded-full border border-line px-4 text-xs font-semibold text-ink-soft transition-colors hover:border-ink-muted hover:text-ink">
                  View transcript
                </Link>
                <Link
                  href="/dashboard/interview/generate"
                  className="inline-flex h-9 items-center justify-center rounded-full border border-line px-4 text-xs font-semibold text-ink-soft transition-colors hover:border-ink-muted hover:text-ink">
                  Retake Interview
                </Link>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {session.scheduledAt ? (
                  <p className="text-xs text-ink-muted">
                    Scheduled for {DATE_FORMAT.format(new Date(session.scheduledAt))}
                  </p>
                ) : null}
                <Link
                  href={session.invitationPath
                    ? `${session.invitationPath}${session.status === "active" ? "/room" : "/waiting"}`
                    : `/interview/${session.sessionId}${session.status === "active" ? "/room" : "/waiting"}`}
                  className="inline-flex h-9 w-fit items-center justify-center rounded-full bg-emerald-400 px-4 text-xs font-semibold text-emerald-950 transition-colors hover:bg-emerald-300">
                  {session.status === "active" ? "Return to interview" : "Go to waiting room"}
                </Link>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
