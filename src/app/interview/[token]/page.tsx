import Link from "next/link";
import { notFound } from "next/navigation";
import { InvitationConfirmation } from "@/components/interview/InvitationConfirmation";
import { RoomHeader } from "@/components/interview/RoomHeader";
import { resolveInvitation } from "@/lib/interview/invitations";

export const instant = false;

/** Invitation confirmation at the project route (FR-SETUP-008). */
export default async function InterviewInvitationPage(
  props: PageProps<"/interview/[token]">,
) {
  const { token } = await props.params;
  const interview = await resolveInvitation(token);
  if (!interview) notFound();

  return (
    <>
      <RoomHeader title="Interview Invitation" />
      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-10">
        <InvitationConfirmation token={token} interview={interview} />
        <p className="mt-6 text-xs text-ink-muted">
          <Link href="/" className="underline decoration-line underline-offset-4 hover:text-ink">
            About AIMIS
          </Link>
        </p>
      </main>
    </>
  );
}
