import Link from "next/link";
import { requireAccount } from "@/lib/auth/guard";
import { listActiveInterviewCategories } from "@/lib/interview/service";
import { listProviderConfigurations } from "@/lib/providers/config";
import { SetupForm } from "@/components/interview/SetupForm";

/**
 * Interview setup (FR-SETUP-001..005, FR-INTERVIEW-001): one screen whose
 * submit creates the session server-side. Categories come from the database
 * (never hardcoded); provider summaries drive the custom-runtime readiness
 * hints and carry no key material (ADR-0005).
 */
export default async function Page() {
  const { account } = await requireAccount({ role: "candidate" });

  const [categories, configurations] = await Promise.all([
    listActiveInterviewCategories(),
    listProviderConfigurations(account.userId),
  ]);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8 lg:py-12">
      <Link
        href="/dashboard"
        className="text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        ← Back to dashboard
      </Link>
      <h1 className="mt-4 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        New interview
      </h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Set up the mock interview; the interviewer tailors its questions from
        these details.
      </p>
      <div className="mt-8">
        <SetupForm categories={categories} configurations={configurations} />
      </div>
    </main>
  );
}
