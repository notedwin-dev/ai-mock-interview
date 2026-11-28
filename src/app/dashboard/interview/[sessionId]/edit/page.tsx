import { notFound } from "next/navigation";
import { requireAccount } from "@/lib/auth/guard";
import { EditInterviewDetails } from "@/components/dashboard/EditInterviewDetails";
import { InterviewError, loadOwnedSession } from "@/lib/interview/service";
import { isEditableSession } from "@/lib/interview/scheduling";

export const instant = false;

/** Editable generated details until the interview starts or completes. */
export default async function Page(
  props: PageProps<"/dashboard/interview/[sessionId]/edit">,
) {
  const { sessionId } = await props.params;
  const { account } = await requireAccount({ role: "candidate" });

  let session: Awaited<ReturnType<typeof loadOwnedSession>>;
  try {
    session = await loadOwnedSession(account.userId, sessionId);
  } catch (error) {
    if (error instanceof InterviewError && error.code === "not_found") notFound();
    throw error;
  }

  // Shared lock rule (also enforced at the API boundary) — see scheduling.ts.
  const locked = !isEditableSession(session);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8 lg:px-10">
      {locked ? (
        <section className="rounded-3xl border border-line bg-surface p-6">
          <h1 className="font-display text-xl font-semibold text-ink">Details are locked</h1>
          <p className="mt-2 text-sm text-ink-muted">
            This interview has already started or completed, so its details cannot be changed.
          </p>
        </section>
      ) : (
        <EditInterviewDetails
          sessionId={session.sessionId}
          config={{
            jobRole: session.jobRole,
            jobDescription: session.jobDescription ?? "",
            experienceLevel: session.experienceLevel ?? "",
            techStack: Array.isArray(session.techStack)
              ? (session.techStack as unknown[]).filter((v): v is string => typeof v === "string")
              : [],
            questionCount: session.questionCount ?? undefined,
            strictness: session.evaluationMode as "supportive" | "balanced" | "rigorous",
            category: session.categoryCodeSnapshot as "general" | "technical" | "behavioral",
          }}
        />
      )}
    </main>
  );
}
