import { notFound } from "next/navigation";
import { InterviewRoom } from "@/components/interview/InterviewRoom";
import { LiveVoice } from "@/components/interview/LiveVoice";
import { resolveInvitation } from "@/lib/interview/invitations";
import { buildLiveInterviewInstructions } from "@/lib/interview/room";
import { createDefaultRoomStore } from "@/lib/interview/room-store";
import { resolveEnabledModel } from "@/lib/providers/config";

// Token lookup is request-specific; render per request so the stream settles.
export const instant = false;

/** Live interview room entered only through a valid invitation link. */
export default async function RoomPage(
  props: PageProps<"/i/[token]/room">,
) {
  const { token } = await props.params;
  const interview = await resolveInvitation(token);
  if (!interview || (interview.status !== "scheduled" && interview.status !== "active")) notFound();

  // Live voice is OPTIONAL and credential-free at render time (ADR-0005):
  // the model id is needed only to label the session; the provider key is
  // never read or decrypted on this path. When it is unavailable the room
  // still works (typed + recorded-voice turns) and tells the user why live
  // voice is off and how to fix it — it never fails silently.
  const context = await createDefaultRoomStore().context(token);
  let liveVoice: { modelId: string; instructions: string } | null = null;
  let liveVoiceNotice: string | null = null;
  if (context) {
    try {
      const enabled = await resolveEnabledModel(context.userId, "realtime");
      if (enabled.providerName === "google") {
        liveVoice = { modelId: enabled.modelId, instructions: buildLiveInterviewInstructions(context) };
      } else {
        liveVoiceNotice = "Live voice needs the Google (Gemini Live) provider for the realtime capability. Configure Google in your provider settings, or continue in text.";
      }
    } catch {
      liveVoiceNotice = "Live voice is not configured for this interview. Enable a realtime provider in your provider settings (Google for live voice), or continue in text.";
    }
  }

  return (
    <main className="mx-auto w-full max-w-[72rem] flex-1 px-4 py-4 lg:px-8">
      {liveVoice ? (
        <LiveVoice token={token} modelId={liveVoice.modelId} instructions={liveVoice.instructions} />
      ) : null}
      {liveVoiceNotice ? (
        <p className="mb-4 rounded-2xl border border-line bg-surface px-4 py-3 text-sm text-ink-muted" role="status">
          {liveVoiceNotice}
        </p>
      ) : null}
      <InterviewRoom token={token} interview={interview} />
    </main>
  );
}
