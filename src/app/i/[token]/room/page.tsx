import { notFound } from "next/navigation";
import { InterviewRoom } from "@/components/interview/InterviewRoom";
import { LiveVoice } from "@/components/interview/LiveVoice";
import { WebRTCRoom } from "@/components/interview/WebRTCRoom";
import { resolveInvitation } from "@/lib/interview/invitations";
import { buildLiveInterviewInstructions } from "@/lib/interview/room";
import { createDefaultRoomStore } from "@/lib/interview/room-store";
import { resolveForOutboundCall } from "@/lib/providers/config";

// Token lookup is request-specific; render per request so the stream settles.
export const instant = false;

/** Live interview room entered only through a valid invitation link. */
export default async function RoomPage(
  props: PageProps<"/i/[token]/room">,
) {
  const { token } = await props.params;
  const interview = await resolveInvitation(token);
  if (!interview || (interview.status !== "scheduled" && interview.status !== "active")) notFound();

  let liveVoice: { modelId: string; instructions: string } | null = null;
  try {
    const context = await createDefaultRoomStore().context(token);
    if (context) {
      const route = await resolveForOutboundCall(context.userId, "realtime");
      liveVoice = {
        modelId: route.modelId,
        instructions: buildLiveInterviewInstructions(context),
      };
    }
  } catch {
    // Optional runtime: typed/voice turns remain available without realtime.
  }

  return (
    <main className="mx-auto w-full max-w-[72rem] flex-1 px-4 py-4 lg:px-8">
      <WebRTCRoom token={token} />
      {liveVoice ? <LiveVoice token={token} {...liveVoice} /> : null}
      <InterviewRoom token={token} interview={interview} />
    </main>
  );
}
