import { Suspense } from "react";
import { requireAccount } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import {
  getActiveRuntimeMode,
  listProviderConfigurations,
  type ProviderConfigSummary,
} from "@/lib/providers/config";
import { ConsoleBanner } from "@/components/dashboard/CapabilityStrip";
import { PastInterviews } from "@/components/dashboard/PastInterviews";
import { UpcomingInterviews } from "@/components/dashboard/UpcomingInterviews";
import { selectRuntime } from "@/lib/interview/runtime";

// Opt out of instant-navigation validation so this segment is allowed to
// block on the server while the auth guard (connection()-based) resolves —
// the documented auth migration pattern (instant.md "Disabling instant";
// authentication-with-cache-components.md "Migrating an existing app").
// Sibling navigation under the dashboard layout is still validated, so each
// page states its own opt-out.
export const instant = false;

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
  scheduledAt: Date | null;
  invitationPath: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

/** One metadata query for a page of sessions, instead of one query per card. */
async function loadInvitationPaths(
  sessionIds: string[],
): Promise<Map<string, string | null>> {
  if (sessionIds.length === 0) return new Map();
  const generations = await db.interviewGeneration.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { sessionId: true, invitationPath: true },
  });
  const paths = new Map<string, string | null>();
  for (const generation of generations) {
    if (!generation.sessionId || paths.has(generation.sessionId)) continue;
    paths.set(generation.sessionId, generation.invitationPath ?? null);
  }
  return paths;
}

async function loadRecentSessions(userId: string): Promise<RecentSessionRow[]> {
  const sessions = await db.interviewSession.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 6,
    select: {
      sessionId: true,
      jobRole: true,
      categoryNameSnapshot: true,
      evaluationMode: true,
      status: true,
      scheduledAt: true,
      createdAt: true,
      completedAt: true,
    },
  });
  const invitationPaths = await loadInvitationPaths(sessions.map((session) => session.sessionId));
  return sessions.map((session) => ({
    ...session,
    invitationPath: invitationPaths.get(session.sessionId) ?? null,
  }));
}

interface UpcomingSessionRow {
  sessionId: string;
  jobRole: string;
  categoryNameSnapshot: string;
  evaluationMode: string;
  scheduledAt: Date | null;
  invitationPath: string | null;
}

/** Not-started sessions the candidate can still edit, schedule or join. */
async function loadUpcomingSessions(userId: string): Promise<UpcomingSessionRow[]> {
  const sessions = await db.interviewSession.findMany({
    where: {
      userId,
      startedAt: null,
      completedAt: null,
      status: { in: ["created", "scheduled"] },
    },
    orderBy: [{ scheduledAt: "asc" }, { createdAt: "desc" }],
    select: {
      sessionId: true,
      jobRole: true,
      categoryNameSnapshot: true,
      evaluationMode: true,
      scheduledAt: true,
    },
  });
  const invitationPaths = await loadInvitationPaths(sessions.map((session) => session.sessionId));
  return sessions.map((session) => ({
    ...session,
    invitationPath: invitationPaths.get(session.sessionId) ?? null,
  }));
}

async function DashboardContent() {
  // Guards re-validate the account against the database on every request;
  // the account_role must match the candidate-only dashboard for now.
  const { account } = await requireAccount({ role: "candidate" });

  let configurations: ProviderConfigSummary[] = [];
  let activeMode: Awaited<ReturnType<typeof getActiveRuntimeMode>> = null;
  let readinessFailed = false;
  try {
    configurations = await listProviderConfigurations(account.userId);
    activeMode = await getActiveRuntimeMode(account.userId);
  } catch {
    // A failed readiness read must not hide the independently loaded session
    // list below; the banner renders its degraded state instead.
    readinessFailed = true;
  }

  let recentSessions: RecentSessionRow[] = [];
  let upcomingSessions: UpcomingSessionRow[] = [];
  let sessionsFailed = false;
  try {
    [recentSessions, upcomingSessions] = await Promise.all([
      loadRecentSessions(account.userId),
      loadUpcomingSessions(account.userId),
    ]);
  } catch {
    sessionsFailed = true;
  }

  // A candidate needs ONE runtime: a native realtime agent or the custom LLM
  // pipeline. The scorer is independent and never gates launching (ADR-006).
  const runtime = selectRuntime(configurations, activeMode);

  return (
    <div className="flex flex-col gap-8 lg:gap-10">
      <ConsoleBanner
        configurations={configurations}
        readinessFailed={readinessFailed}
        runtimeReady={!readinessFailed && runtime.ready}
        runtimeMode={runtime.mode}
        runtimeProvider={runtime.servingProvider}
      />

      <section aria-labelledby="upcoming-sessions-heading">
        <div className="flex items-baseline justify-between gap-4">
          <h2
            id="upcoming-sessions-heading"
            className="font-display text-xl font-semibold tracking-tight text-ink"
          >
            Your interviews waiting to happen
          </h2>
        </div>
        <div className="mt-4">
          {sessionsFailed ? (
            <p className="py-6 text-sm text-ink-muted">
              Your interview list could not be loaded. Try again in a moment.
            </p>
          ) : (
            <UpcomingInterviews
              sessions={upcomingSessions.map((session) => ({
                ...session,
                scheduledAt: session.scheduledAt?.toISOString() ?? null,
              }))}
            />
          )}
        </div>
      </section>

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
            <PastInterviews
              sessions={recentSessions.map((session) => ({
                ...session,
                scheduledAt: session.scheduledAt?.toISOString() ?? null,
              }))}
            />
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
