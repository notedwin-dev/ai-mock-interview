import Link from "next/link";

/**
 * The rehearsal log: recent sessions as a ruled list (not a card grid).
 * Status is always dot + word, never colour alone. A server component —
 * the whole row deep-links into the interview room.
 */

const STATUS_WORDS: Record<string, { word: string; dot: string; text: string }> = {
  created: { word: "Set up", dot: "bg-stone-400", text: "text-stone-500 dark:text-stone-400" },
  active: { word: "In progress", dot: "bg-teal-600 dark:bg-teal-400", text: "text-teal-700 dark:text-teal-300" },
  completed: { word: "Completed", dot: "bg-stone-500 dark:bg-stone-400", text: "text-stone-600 dark:text-stone-300" },
  failed: { word: "Failed", dot: "bg-red-600 dark:bg-red-400", text: "text-red-700 dark:text-red-300" },
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

export function SessionLog({ sessions }: SessionLogProps) {
  if (sessions.length === 0) {
    return (
      <p className="py-6 text-sm text-stone-500 dark:text-stone-400">
        No sessions yet — your first round is one click away.
      </p>
    );
  }

  const dateFormatter = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <ul className="divide-y divide-stone-200 dark:divide-stone-800">
      {sessions.map((session) => {
        const status = STATUS_WORDS[session.status] ?? STATUS_WORDS.created;
        return (
          <li key={session.sessionId}>
            <Link
              href={`/dashboard/interview/${session.sessionId}`}
              className="group grid cursor-pointer grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 py-3.5 outline-none transition-colors hover:bg-stone-50 focus-visible:bg-stone-50 dark:hover:bg-stone-900 dark:focus-visible:bg-stone-900"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-stone-900 transition-colors group-hover:text-teal-800 dark:text-stone-100 dark:group-hover:text-teal-300">
                  {session.jobRole}
                </span>
                <span className="mt-0.5 block truncate text-xs text-stone-500 dark:text-stone-400">
                  {session.categoryNameSnapshot}, {session.evaluationMode} evaluation
                </span>
              </span>
              <span className="flex items-baseline justify-end gap-3 sm:gap-5">
                <span className={`flex items-center gap-1.5 text-xs font-medium ${status.text}`}>
                  <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                  {status.word}
                </span>
                <span className="hidden text-xs tabular-nums text-stone-400 sm:inline dark:text-stone-500">
                  {dateFormatter.format(session.createdAt)}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
