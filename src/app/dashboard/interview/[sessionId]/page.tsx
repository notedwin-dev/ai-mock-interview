import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAccount } from "@/lib/auth/guard";
import {
  InterviewError,
  getOwnInterviewTranscript,
} from "@/lib/interview/service";
import { RoomControls } from "@/components/interview/RoomControls";

/**
 * Meeting-style interview room (FR-INTERVIEW-003): renders the owner's
 * session snapshot and chronological transcript; controls delegate to the
 * /api/v1/interviews/[sessionId] routes. Another candidate's session is a
 * 404 here (ownership enforced by the service).
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
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8 lg:py-12">
      <Link
        href="/dashboard"
        className="text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        ← Back to dashboard
      </Link>
      <RoomControls
        initialSession={data.session}
        initialMessages={data.messages}
      />
    </main>
  );
}
