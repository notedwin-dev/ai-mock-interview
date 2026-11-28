import { redirect } from "next/navigation";

// Token lookup is request-specific (legacy redirect); block prerendering.
export const instant = false;

/** Legacy invitation path; the project route is /interview/[token]. */
export default async function LegacyInvitationPage(
  props: PageProps<"/i/[token]">,
) {
  const { token } = await props.params;
  redirect(`/interview/${token}`);
}
