import { Suspense } from "react";
import { requireAccount } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import {
  listProviderConfigurations,
  type ProviderConfigSummary,
} from "@/lib/providers/config";
import {
  CapabilityStrip,
  ConsoleBanner,
} from "@/components/dashboard/CapabilityStrip";
import { PastInterviews } from "@/components/dashboard/PastInterviews";

/**
 * Candidate dashboard (TT-6, reference-design-adapted): a hero banner with the
 * primary action over a signal-chain strip, then "Your past interviews" as a
 * restrained card grid of real sessions. The shell (dashboard/layout.tsx)
 * owns identity, navigation and sign-out. Server components read via Prisma
 * / services directly (ARCHITECTURE §4); readiness summaries carry no
 * credential material (ADR-0005).
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
    take: 6,
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
    <div className="flex flex-col gap-8 lg:gap-10">
      <ConsoleBanner
        configurations={configurations}
        readinessFailed={readinessFailed}
      />
      <CapabilityStrip
        configurations={configurations}
        readinessFailed={readinessFailed}
      />

      <section aria-labelledby="recent-sessions-heading">
        <div className="flex items-baseline justify-between gap-4">
          <h2
            id="recent-sessions-heading"
            className="font-display text-xl font-semibold tracking-tight text-ink"
          >
            Your past interviews
          </h2>
          {sessionsFailed ? (
            <span className="text-xs text-ink-muted">
              Could not load sessions
            </span>
          ) : null}
        </div>
        <div className="mt-4">
          {sessionsFailed ? (
            <p className="py-6 text-sm text-ink-muted">
              Your session list could not be loaded. Try again in a moment.
            </p>
          ) : (
            <PastInterviews sessions={recentSessions} />
          )}
        </div>
      </section>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-[80rem] flex-1 px-6 py-8 lg:px-10 lg:py-10">
      <Suspense fallback={<p className="text-sm text-ink-muted">Loading…</p>}>
        <DashboardContent />
      </Suspense>
    </main>
  );
}
