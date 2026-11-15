import { notFound } from "next/navigation";
import { requireAccount } from "@/lib/auth/guard";
import {
  InterviewError,
  getOwnInterviewTranscript,
} from "@/lib/interview/service";
import { RoomControls } from "@/components/interview/RoomControls";

/**
 * Meeting-style interview room (FR-INTERVIEW-003), reference-design-adapted: the
 * owner's session snapshot and chronological transcript render as a
 * two-participant layout with an added conversation sidebar (speaker
 * attribution is an AIMIS requirement the reference lacks). Controls
 * delegate to the /api/v1/interviews/[sessionId] routes. Another candidate's
 * session is a 404 here (ownership enforced by the service).
 */
export default async function Page(
  props: PageProps<"/dashboard/interview/[sessionId]">,
) {
  const { sessionId } = await props.params;
  const { account } = await requireAccount({ role: "candidate" });

  let data: Awaited<ReturnType<typeof getOwnInterviewTranscript>>;
  try {
    data = await getOwnInterviewTranscript(account.userId, sessionId);
  } catch (error) {
    if (
      error instanceof InterviewError &&
      (error.code === "not_found" || error.code === "invalid_input")
    ) {
      notFound();
    }
    throw error;
  }

  return (
    <main className="mx-auto w-full max-w-[72rem] flex-1 px-6 py-8 lg:px-10 lg:py-10">
      <RoomControls
        initialSession={data.session}
        initialMessages={data.messages}
      />
    </main>
  );
}
