import { Suspense } from "react";
import Link from "next/link";
import { signOut } from "@/lib/auth";
import { requireAccount } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import {
  listProviderConfigurations,
  type ProviderConfigSummary,
} from "@/lib/providers/config";
import { SignalChain } from "@/components/dashboard/SignalChain";
import { SessionLog } from "@/components/dashboard/SessionLog";

/**
 * Candidate dashboard (TT-6): a rehearsal-room console. The signal-chain
 * panel is the primary surface (FR-SETUP-005, FR-INTERVIEW-001); recent
 * sessions sit below as a ruled log. Server components read via Prisma /
 * services directly (ARCHITECTURE §4); readiness summaries carry no
 * credential material (ADR-0005).
 */

async function signOutAction(): Promise<void> {
  "use server";
  await signOut({ redirectTo: "/" });
}

interface RecentSessionRow {
  sessionId: string;
  jobRole: string;
  categoryNameSnapshot: string;
  evaluationMode: string;
  status: string;
  createdAt: Date;
}

function loadRecentSessions(userId: string): Promise<RecentSessionRow[]> {
  return db.interviewSession.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      sessionId: true,
      jobRole: true,
      categoryNameSnapshot: true,
      evaluationMode: true,
      status: true,
      createdAt: true,
    },
  });
}

async function DashboardContent() {
  // Guards re-validate the account against the database on every request;
  // the account_role must match the candidate-only dashboard for now.
  const { account } = await requireAccount({ role: "candidate" });

  let configurations: ProviderConfigSummary[] = [];
  let readinessFailed = false;
  try {
    configurations = await listProviderConfigurations(account.userId);
  } catch {
    readinessFailed = true;
  }

  let recentSessions: RecentSessionRow[] = [];
  let sessionsFailed = false;
  try {
    recentSessions = await loadRecentSessions(account.userId);
  } catch {
    sessionsFailed = true;
  }

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-stone-200 pb-5 dark:border-stone-800">
        <p className="flex items-baseline gap-2.5">
          <span className="font-display text-lg font-bold tracking-tight text-stone-900 dark:text-stone-50">
            AIMIS
          </span>
          <span className="text-xs text-stone-500 dark:text-stone-400">
            practice studio
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="max-w-52 truncate text-xs text-stone-500 dark:text-stone-400">
            {account.email}
          </span>
          <Link
            href="/dashboard/profile"
            className="cursor-pointer text-sm font-medium text-stone-700 underline decoration-stone-300 underline-offset-4 outline-none transition-colors hover:text-stone-900 focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2 dark:text-stone-300 dark:decoration-stone-600 dark:hover:text-stone-100 dark:focus-visible:ring-teal-300"
          >
            Profile
          </Link>
          <form action={signOutAction}>
            <button
              type="submit"
              className="inline-flex h-9 cursor-pointer items-center rounded-lg border border-stone-300 px-3.5 text-sm font-medium text-stone-700 outline-none transition-colors hover:border-stone-400 hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800 dark:focus-visible:ring-teal-300"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <SignalChain configurations={configurations} readinessFailed={readinessFailed} />

      <section aria-labelledby="recent-sessions-heading">
        <div className="flex items-baseline justify-between gap-4">
          <h2
            id="recent-sessions-heading"
            className="font-display text-base font-semibold tracking-tight text-stone-900 dark:text-stone-100"
          >
            Recent sessions
          </h2>
          {sessionsFailed ? (
            <span className="text-xs text-stone-500 dark:text-stone-400">
              Could not load sessions
            </span>
          ) : null}
        </div>
        <div className="mt-2">
          {sessionsFailed ? (
            <p className="py-6 text-sm text-stone-500 dark:text-stone-400">
              Your session list could not be loaded. Try again in a moment.
            </p>
          ) : (
            <SessionLog sessions={recentSessions} />
          )}
        </div>
      </section>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10 sm:py-14">
      <Suspense fallback={<p className="text-sm text-stone-500">Loading…</p>}>
        <DashboardContent />
      </Suspense>
    </main>
  );
}
