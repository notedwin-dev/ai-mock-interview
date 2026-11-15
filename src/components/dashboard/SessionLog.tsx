import Link from "next/link";

/**
 * The rehearsal log: recent sessions as a date-grouped ruled list (not a card
 * grid). Status is always dot + word, never colour alone. A server component —
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

const DAY_MS = 86_400_000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Group heading for a session's date: Today / Yesterday / "3 Nov" (with the
 * year once it is not the current one). Server-side clock; the list arrives
 * sorted newest-first, so groups keep that order.
 */
function groupLabel(date: Date, now: Date): string {
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(
    "en-GB",
    sameYear
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "short", year: "numeric" },
  ).format(date);
}

export function SessionLog({ sessions }: SessionLogProps) {
  if (sessions.length === 0) {
    return (
      <p className="py-6 text-sm text-stone-500 dark:text-stone-400">
        No sessions yet — your first round is one click away.
      </p>
    );
  }

  const now = new Date();
  const groups: Array<{ label: string; items: typeof sessions }> = [];
  for (const session of sessions) {
    const label = groupLabel(session.createdAt, now);
    const current = groups[groups.length - 1];
    if (current && current.label === label) {
      current.items.push(session);
    } else {
      groups.push({ label, items: [session] });
    }
  }

  return (
    <ul className="flex flex-col">
      {groups.map((group, groupIndex) => (
        <li key={group.label}>
          <p
            className={`text-xs font-medium text-stone-400 dark:text-stone-500 ${
              groupIndex === 0 ? "pb-1" : "pb-1 pt-6"
            }`}
          >
            {group.label}
          </p>
          <ul className="divide-y divide-stone-200 dark:divide-stone-800">
            {group.items.map((session) => {
              const status = STATUS_WORDS[session.status] ?? STATUS_WORDS.created;
              return (
                <li key={session.sessionId}>
                  <Link
                    href={`/dashboard/interview/${session.sessionId}`}
                    className="group grid cursor-pointer grid-cols-[1fr_auto] items-baseline gap-x-4 py-3 outline-none transition-colors hover:bg-stone-50 focus-visible:bg-stone-50 dark:hover:bg-stone-900 dark:focus-visible:bg-stone-900"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-stone-900 transition-colors group-hover:text-teal-800 dark:text-stone-100 dark:group-hover:text-teal-300">
                        {session.jobRole}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-stone-500 dark:text-stone-400">
                        {session.categoryNameSnapshot}, {session.evaluationMode}{" "}
                        evaluation
                      </span>
                    </span>
                    <span
                      className={`flex items-center gap-1.5 text-xs font-medium ${status.text}`}
                    >
                      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                      {status.word}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}
