import { notFound } from "next/navigation";
import { InterviewRoom } from "@/components/interview/InterviewRoom";
import { resolveInvitation } from "@/lib/interview/invitations";

/** Live interview room entered only through a valid invitation link. */
export default async function RoomPage(
  props: PageProps<"/i/[token]/room">,
) {
  const { token } = await props.params;
  const interview = await resolveInvitation(token);
  if (!interview || (interview.status !== "scheduled" && interview.status !== "active")) notFound();

  return (
    <main className="mx-auto w-full max-w-[72rem] flex-1 px-4 py-4 lg:px-8">
      <InterviewRoom token={token} interview={interview} />
    </main>
  );
}
