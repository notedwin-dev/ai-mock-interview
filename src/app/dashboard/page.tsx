import { Suspense } from "react";
import Link from "next/link";
import { signOut } from "@/lib/auth";
import { requireAccount } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import {
  listProviderConfigurations,
  type ProviderConfigSummary,
} from "@/lib/providers/config";

/**
 * Candidate dashboard (TT-6): provider readiness, the new-interview entry
 * point (FR-SETUP-005, FR-INTERVIEW-001) and recent sessions. Server
 * components read via Prisma / services directly (ARCHITECTURE §4); readiness
 * summaries carry no credential material (ADR-0005).
 */

async function signOutAction(): Promise<void> {
  "use server";
  await signOut({ redirectTo: "/" });
}

/** Capabilities surfaced on the dashboard; scorer is internal and not shown. */
const TRACKED_CAPABILITIES = ["asr", "llm", "tts"] as const;
type TrackedCapability = (typeof TRACKED_CAPABILITIES)[number];

const CAPABILITY_LABELS: Record<TrackedCapability, string> = {
  asr: "Speech recognition (ASR)",
  llm: "Interviewer (LLM)",
  tts: "Voice output (TTS)",
};

const CREDENTIAL_STATUS_LABELS: Record<string, string> = {
  unvalidated: "not validated",
  valid: "validated",
  invalid: "failed validation",
};

const SESSION_STATUS_CLASSES: Record<string, string> = {
  created: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  completed: "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300",
};

interface RecentSessionRow {
  sessionId: string;
  jobRole: string;
  categoryNameSnapshot: string;
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
      status: true,
      createdAt: true,
    },
  });
}

/** Enabled configurations serving the capability — mirrors resolveForOutboundCall. */
function servingRows(
  rows: ProviderConfigSummary[],
  capability: TrackedCapability,
): ProviderConfigSummary[] {
  return rows.filter((row) => row.isEnabled && row.capabilities[capability]);
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

  // Session creation resolves exactly this: an enabled provider row serving
  // llm (resolveForOutboundCall, then loadRouteSnapshot). Mirroring it here
  // keeps the CTA from inviting a provider_route_missing failure.
  const llmReady = servingRows(configurations, "llm").length > 0;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          Signed in as{" "}
          <span className="font-medium text-zinc-900 dark:text-zinc-100">
            {account.email}
          </span>{" "}
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {account.accountRole}
          </span>
        </p>
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/profile"
            className="inline-flex h-10 items-center rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            Profile
          </Link>
          <form action={signOutAction}>
            <button
              type="submit"
              className="inline-flex h-10 items-center rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Practice
        </h2>
        <div className="mt-2 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            New interview
          </h3>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Configure a target role, job description and interview style, then
            enter the meeting-style room.
          </p>
          {llmReady ? (
            <Link
              href="/dashboard/interview/new"
              className="mt-4 inline-flex h-10 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-zinc-50 transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              Start a new interview
            </Link>
          ) : (
            <div className="mt-4 flex flex-col items-start gap-2">
              <button
                type="button"
                disabled
                aria-disabled
                className="inline-flex h-10 cursor-not-allowed items-center rounded-md bg-zinc-300 px-4 text-sm font-medium text-zinc-500 dark:bg-zinc-700 dark:text-zinc-500"
              >
                Start a new interview
              </button>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                No enabled provider configuration serves the LLM capability
                yet.{" "}
                <Link
                  href="/dashboard/profile"
                  className="font-medium text-zinc-900 underline dark:text-zinc-100"
                >
                  Fix it in Profile
                </Link>
              </p>
            </div>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Provider readiness
        </h2>
        <div className="mt-2 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
          {readinessFailed ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Could not load provider readiness. Try again later.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {TRACKED_CAPABILITIES.map((capability) => {
                const rows = servingRows(configurations, capability);
                return (
                  <li
                    key={capability}
                    className="flex flex-wrap items-center justify-between gap-3"
                  >
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {CAPABILITY_LABELS[capability]}
                    </span>
                    {rows.length === 0 ? (
                      <span className="text-sm text-zinc-600 dark:text-zinc-400">
                        Not configured —{" "}
                        <Link
                          href="/dashboard/profile"
                          className="underline hover:text-zinc-900 dark:hover:text-zinc-100"
                        >
                          configure
                        </Link>
                      </span>
                    ) : (
                      <span className="flex flex-wrap justify-end gap-2">
                        {rows.map((row) => (
                          <span
                            key={row.userProviderConfigurationId}
                            className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                          >
                            {row.providerName} ·{" "}
                            {CREDENTIAL_STATUS_LABELS[row.credentialStatus] ??
                              row.credentialStatus}
                          </span>
                        ))}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Recent sessions
        </h2>
        <div className="mt-2 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
          {sessionsFailed ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Could not load sessions. Try again later.
            </p>
          ) : recentSessions.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              No interviews yet — start your first one above.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {recentSessions.map((session) => (
                <li key={session.sessionId}>
                  <Link
                    href={`/dashboard/interview/${session.sessionId}`}
                    className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                  >
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">
                      {session.jobRole}
                    </span>
                    <span>{session.categoryNameSnapshot}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        SESSION_STATUS_CLASSES[session.status] ??
                        SESSION_STATUS_CLASSES.created
                      }`}
                    >
                      {session.status}
                    </span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {session.createdAt.toISOString().slice(0, 10)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        Dashboard
      </h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Your mock interview practice home.
      </p>
      <div className="mt-8">
        <Suspense fallback={<p className="text-sm text-zinc-600">Loading…</p>}>
          <DashboardContent />
        </Suspense>
      </div>
    </main>
  );
}
