import { redirect } from "next/navigation";

// Token lookup is request-specific (legacy redirect); block prerendering.
export const instant = false;

/**
 * Legacy room path; the live room now lives at /interview/[token]/room (which
 * selects exactly one runtime UI per session). Our earlier in-place rendering
 * here was superseded by that project route, so this path is a redirect rather
 * than a duplicate implementation of the room.
 */
export default async function LegacyRoomPage(
  props: PageProps<"/i/[token]/room">,
) {
  const { token } = await props.params;
  redirect(`/interview/${token}/room`);
}
