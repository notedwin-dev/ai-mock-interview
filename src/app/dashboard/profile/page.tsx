import { Suspense } from "react";
import Link from "next/link";
import { requireAccount } from "@/lib/auth/guard";

/**
 * Profile page (round 5): identity now, with provider management moved to the
 * dedicated AI configuration experience (/dashboard/configuration) — the
 * capability-first configurator owns provider rows, keys, models, tests and
 * readiness. Resume and visibility management arrive with the profile slice.
 * The dynamic account access sits inside a Suspense boundary (same pattern
 * as the dashboard and configuration pages).
 */

const LINK_PILL =
  "inline-flex h-10 cursor-pointer items-center rounded-full bg-emerald-400 px-5 text-sm font-semibold text-emerald-950 outline-none transition-all hover:bg-emerald-300 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-emerald-400";

async function ProfileContent() {
  const { account } = await requireAccount({ role: "candidate" });

  return (
    <>
      <p className="mt-1 text-sm text-ink-muted">
        Signed in as {account.email} ({account.accountRole}).
      </p>

      <section className="mt-8 rounded-2xl border border-line bg-surface p-6">
        <h2 className="font-display text-lg font-semibold tracking-tight text-ink">
          AI configuration
        </h2>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-muted">
          Providers, credentials, models, capability tests and readiness for
          the four independent capabilities (ASR, interviewer LLM, voice
          output, evaluation scorer) live on the configuration page.
        </p>
        <div className="mt-4">
          <Link href="/dashboard/configuration" className={LINK_PILL}>
            Open AI configuration
          </Link>
        </div>
      </section>

      <p className="mt-4 text-xs text-ink-muted">
        Resume and visibility management arrive with the profile slice.
      </p>
    </>
  );
}

export default function ProfilePage() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8 lg:py-12">
      <Link
        href="/dashboard"
        className="text-sm text-ink-soft transition-colors hover:text-ink"
      >
        ← Back to dashboard
      </Link>
      <h1 className="mt-4 font-display text-2xl font-semibold tracking-tight text-ink">
        Profile
      </h1>
      <Suspense fallback={<p className="mt-1 text-sm text-ink-muted">Loading…</p>}>
        <ProfileContent />
      </Suspense>
    </main>
  );
}
