import Link from "next/link";
import { requireAccount } from "@/lib/auth/guard";
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
  await requireAccount({ role: "candidate" });

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8 lg:py-12">
      <Link href="/dashboard" className="text-sm text-ink-soft transition-colors hover:text-ink">
        ← Back to dashboard
      </Link>
      <h1 className="mt-4 font-display text-2xl font-semibold tracking-tight text-ink">
        Launch AI Interview Agent
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
        Tell the agent what you want to practise. It gathers the purpose, role,
        job description and evaluation strictness, then shows you the generated
        configuration before creating a ready interview.
      </p>
      <div className="mt-6">
        <InterviewAgent />
      </div>
    </main>
  );
}
