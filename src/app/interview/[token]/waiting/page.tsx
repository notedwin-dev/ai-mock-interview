import { notFound } from "next/navigation";
import { RoomHeader } from "@/components/interview/RoomHeader";
import { WaitingRoom } from "@/components/interview/WaitingRoom";
import { resolveInvitation } from "@/lib/interview/invitations";

export const instant = false;

/** Token-scoped waiting room at the project route. */
export default async function InterviewWaitingPage(
  props: PageProps<"/interview/[token]/waiting">,
) {
  const { token } = await props.params;
  const interview = await resolveInvitation(token);
  if (!interview || interview.status !== "scheduled") notFound();

  return (
    <>
      <RoomHeader title="Waiting room" />
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
        <WaitingRoom token={token} interview={interview} />
      </main>
    </>
  );
}
