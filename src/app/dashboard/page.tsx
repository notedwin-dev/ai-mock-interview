import { Suspense } from "react";
import { requireAccount } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import {
  listProviderConfigurations,
  type ProviderConfigSummary,
} from "@/lib/providers/config";
import { SignalChain } from "@/components/dashboard/SignalChain";
import { SessionLog } from "@/components/dashboard/SessionLog";

/**
 * Candidate dashboard (TT-6): a rehearsal-room console, desktop-first. The
 * signal-chain panel is the primary surface (FR-SETUP-005, FR-INTERVIEW-001);
 * recent sessions sit below as a date-grouped rehearsal log. The shell
 * (dashboard/layout.tsx) owns identity, navigation and sign-out. Server
 * components read via Prisma / services directly (ARCHITECTURE §4); readiness
 * summaries carry no credential material (ADR-0005).
 */

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
    <div className="flex flex-col gap-10 lg:gap-12">
      <SignalChain configurations={configurations} readinessFailed={readinessFailed} />

      <section aria-labelledby="recent-sessions-heading">
        <div className="flex items-baseline justify-between gap-4">
          <h2
            id="recent-sessions-heading"
            className="font-display text-lg font-semibold tracking-tight text-stone-900 dark:text-stone-100"
          >
            Recent sessions
          </h2>
          {sessionsFailed ? (
            <span className="text-xs text-stone-500 dark:text-stone-400">
              Could not load sessions
            </span>
          ) : null}
        </div>
        <div className="mt-1">
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
    <main className="mx-auto w-full max-w-[76rem] flex-1 px-6 py-8 lg:px-12 lg:py-10">
      <Suspense fallback={<p className="text-sm text-stone-500">Loading…</p>}>
        <DashboardContent />
      </Suspense>
    </main>
  );
}
