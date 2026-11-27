import Link from "next/link";
import { requireAccount } from "@/lib/auth/guard";
import { listProviderConfigurations } from "@/lib/providers/config";
import { listActiveInterviewCategories } from "@/lib/interview/service";
import { selectRuntime } from "@/lib/interview/runtime";
import { InterviewAgent } from "@/components/interview/InterviewAgent";

// Opt out of instant-navigation validation so this segment is allowed to
// block on the server while the auth guard (connection()-based) resolves —
// the documented auth migration pattern (instant.md "Disabling instant";
// authentication-with-cache-components.md "Migrating an existing app").
// Sibling navigation under the dashboard layout is still validated, so each
// page states its own opt-out.
export const instant = false;

/**
 * AI Interview Agent entry (FR-SETUP-006). The dashboard's primary creation
 * action opens this conversation; generation and interview creation both run
 * server-side. The manual setup form remains available as a fallback only.
 *
 * Auth is read at page level (not inside a nested Suspense boundary) so the
 * dynamic render resolves as one stream instead of an open boundary.
 */
export default async function AgentPage() {
  const { account } = await requireAccount({ role: "candidate" });
  const runtime = selectRuntime(await listProviderConfigurations(account.userId));
  const categories = await listActiveInterviewCategories();

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8 lg:py-12">
      <Link href="/dashboard" className="back-link">
        ← Back to dashboard
      </Link>
      <h1 className="page-title">
        Launch AI Interview Agent
      </h1>
      <p className="page-lede">
        Tell the agent what you want to practise. It gathers the purpose, role,
        job description and evaluation strictness, then shows you the generated
        configuration before creating a ready interview.
      </p>
      <div className="mt-6">
        <InterviewAgent
          runtimeMode={runtime.mode}
          categoryId={categories.find((category) => category.categoryCode === "general")?.categoryId}
        />
      </div>
    </main>
  );
}
