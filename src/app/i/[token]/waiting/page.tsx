import { notFound } from "next/navigation";
import { WaitingRoom } from "@/components/interview/WaitingRoom";
import { resolveInvitation } from "@/lib/interview/invitations";

// Token lookup is request-specific; render per request so the stream settles.
export const instant = false;

/** Token-scoped waiting room (FR-SETUP-007/008, TT-8 room re-layer). */
export default async function WaitingPage(
  props: PageProps<"/i/[token]/waiting">,
) {
  const { token } = await props.params;
  const interview = await resolveInvitation(token);
  if (!interview || interview.status !== "scheduled") notFound();

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
      <WaitingRoom token={token} interview={interview} />
    </main>
  );
}
