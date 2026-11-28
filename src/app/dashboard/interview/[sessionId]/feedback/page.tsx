import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAccount } from "@/lib/auth/guard";
import { db } from "@/lib/db";

export const instant = false;

/** Feedback entry for a completed interview (M3 evaluation surface). */
export default async function FeedbackPage(
  props: PageProps<"/dashboard/interview/[sessionId]/feedback">,
) {
  const { sessionId } = await props.params;
  const { account } = await requireAccount({ role: "candidate" });
  const session = await db.interviewSession.findFirst({
    where: { sessionId, userId: account.userId },
    select: {
      sessionId: true,
      jobRole: true,
      categoryNameSnapshot: true,
      evaluationMode: true,
      status: true,
      createdAt: true,
      completedAt: true,
    },
  });
  if (!session) notFound();

  const evaluation = await db.interviewEvaluation.findUnique({
    where: { sessionId },
    select: {
      evaluationStatus: true,
      interviewSummary: true,
      overallScore: true,
      strengthsJson: true,
      improvementAreasJson: true,
    },
  });

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8 lg:py-12">
      <Link href="/dashboard" className="text-sm text-ink-soft hover:text-ink">← Back to dashboard</Link>
      <h1 className="mt-4 font-display text-2xl font-semibold text-ink">Interview feedback</h1>
      <p className="mt-2 text-sm text-ink-muted">
        {session.jobRole} · {session.categoryNameSnapshot} · {session.evaluationMode} evaluation
      </p>

      <div className="mt-6 rounded-2xl border border-line bg-surface p-6">
        {evaluation?.evaluationStatus === "completed" && evaluation.interviewSummary ? (
          <>
            {evaluation.overallScore ? (
              <p className="text-sm text-ink-muted">
                Overall score: <strong className="text-ink">{String(evaluation.overallScore)}/5</strong>
              </p>
            ) : null}
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">{evaluation.interviewSummary}</p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-ink">Your interview is saved.</p>
            <p className="mt-2 text-sm text-ink-muted">
              Structured feedback is generated after the interview completes. It will appear
              here when the evaluation is ready.
            </p>
          </>
        )}
      </div>

      <div className="mt-6 flex gap-3">
        <Link href="/dashboard/interview/generate" className="rounded-full border border-line px-5 py-2 text-sm text-ink-soft hover:border-ink-muted">
          Retake interview
        </Link>
      </div>
    </main>
  );
}
