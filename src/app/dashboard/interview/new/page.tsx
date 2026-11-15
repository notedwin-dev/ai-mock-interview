import Link from "next/link";
import { requireAccount } from "@/lib/auth/guard";
import { listActiveInterviewCategories } from "@/lib/interview/service";
import { listProviderConfigurations } from "@/lib/providers/config";
import { SetupForm } from "@/components/interview/SetupForm";

/**
 * Interview setup (FR-SETUP-001..005, FR-INTERVIEW-001), reference-design-adapted:
 * one centred card, plain question-style labels, select controls where a
 * dropdown reads simpler and stacked mutually exclusive cards where the FR
 * pins them (runtime mode, FR-SETUP-005 acceptance wording). Categories come
 * from the database (never hardcoded); provider summaries drive the
 * custom-runtime readiness hints and carry no key material (ADR-0005).
 */
export default async function Page() {
  const { account } = await requireAccount({ role: "candidate" });

  const [categories, configurations] = await Promise.all([
    listActiveInterviewCategories(),
    listProviderConfigurations(account.userId),
  ]);

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-8 lg:py-12">
      <div className="w-full max-w-xl">
        <Link
          href="/dashboard"
          className="text-sm text-ink-soft transition-colors hover:text-ink"
        >
          ← Back to dashboard
        </Link>
        <div className="mt-4 rounded-3xl border border-line bg-surface p-8 sm:p-10">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
            Starting your interview
          </h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            Customize the mock interview to suit your needs; the interviewer
            tailors its questions from these details.
          </p>
          <div className="mt-8">
            <SetupForm categories={categories} configurations={configurations} />
          </div>
        </div>
      </div>
    </main>
  );
}
