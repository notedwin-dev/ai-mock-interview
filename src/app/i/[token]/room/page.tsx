import { redirect } from "next/navigation";

export const instant = false;

/** Legacy room path; the project route is /interview/[token]/room. */
export default async function LegacyRoomPage(
  props: PageProps<"/i/[token]/room">,
) {
  const { token } = await props.params;
  redirect(`/interview/${token}/room`);
}
