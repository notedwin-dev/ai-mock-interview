import { notFound } from "next/navigation";
import { requireAccount } from "@/lib/auth/guard";
import { InterviewReady } from "@/components/interview/InterviewReady";
import { getOwnInterviewTranscript } from "@/lib/interview/service";
import { db } from "@/lib/db";

export const instant = false;

/** Standalone post-confirmation page: review details, then start / schedule / leave. */
export default async function Page(
  props: PageProps<"/dashboard/interview/[sessionId]/ready">,
) {
  const { sessionId } = await props.params;
  const { account } = await requireAccount({ role: "candidate" });
  let data: Awaited<ReturnType<typeof getOwnInterviewTranscript>>;
  try {
    data = await getOwnInterviewTranscript(account.userId, sessionId);
  } catch {
    notFound();
  }
  const generation = await db.interviewGeneration.findFirst({
    where: { sessionId },
    select: { invitationPath: true },
  });
  if (!generation?.invitationPath) notFound();
  const s = data.session;
  return (
    <InterviewReady
      sessionId={s.sessionId}
      role={s.jobRole}
      category={s.categoryNameSnapshot}
      mode={s.evaluationMode}
      questions={s.questionCount}
      topics={s.techStack}
      level={s.experienceLevel}
      invitationPath={generation.invitationPath}
    />
  );
}
