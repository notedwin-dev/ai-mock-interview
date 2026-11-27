import { notFound } from "next/navigation";
import { InterviewRoom } from "@/components/interview/InterviewRoom";
import { RoomHeader } from "@/components/interview/RoomHeader";
import { WebRTCRoom } from "@/components/interview/WebRTCRoom";
import { resolveInvitation } from "@/lib/interview/invitations";

export const instant = false;

/**
 * Live interview room at the project route. ADR-006: exactly one runtime UI
 * per session — LiveKit WebRTC for a realtime session, typed agent otherwise.
 */
export default async function InterviewRoomPage(
  props: PageProps<"/interview/[token]/room">,
) {
  const { token } = await props.params;
  // One-click join: the waiting room navigates to this page with ?autojoin=1,
  // which the WebRTCRoom consumes to connect without a second click. The flag
  // is a URL query param (awaited request-time data; the page opts out of
  // instant navigation above), so it needs no client-side plumbing.
  const { autojoin } = await props.searchParams;
  const autoJoin = autojoin === "1";
  const interview = await resolveInvitation(token);
  if (!interview || (interview.status !== "scheduled" && interview.status !== "active")) notFound();

  const isRealtime = interview.runtimeMode === "preset_realtime";

  return (
    <>
      <RoomHeader title="Live interview" />
      <main className="mx-auto w-full max-w-[72rem] flex-1 px-4 py-4 lg:px-8">
        {isRealtime ? (
          <WebRTCRoom token={token} sessionId={interview.sessionId} autoJoin={autoJoin} />
        ) : (
          <InterviewRoom token={token} interview={interview} />
        )}
      </main>
    </>
  );
}
