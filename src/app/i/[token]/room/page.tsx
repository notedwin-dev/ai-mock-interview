import { notFound } from "next/navigation";
import { InterviewRoom } from "@/components/interview/InterviewRoom";
import { WebRTCRoom } from "@/components/interview/WebRTCRoom";
import { resolveInvitation } from "@/lib/interview/invitations";

// Token lookup is request-specific; render per request so the stream settles.
export const instant = false;

/**
 * Live interview room entered only through a valid invitation link.
 * ADR-006: a session runs on exactly ONE runtime, so exactly one room UI is
 * rendered — the LiveKit WebRTC room for a realtime session, the typed agent
 * room for a custom-pipeline session. Never stack competing mic/transport UIs.
 */
export default async function RoomPage(
  props: PageProps<"/i/[token]/room">,
) {
  const { token } = await props.params;
  const interview = await resolveInvitation(token);
  if (!interview || (interview.status !== "scheduled" && interview.status !== "active")) notFound();

  const isRealtime = interview.runtimeMode === "preset_realtime";

  return (
    <main className="mx-auto w-full max-w-[72rem] flex-1 px-4 py-4 lg:px-8">
      {isRealtime ? (
        <WebRTCRoom token={token} />
      ) : (
        <InterviewRoom token={token} interview={interview} />
      )}
    </main>
  );
}
