import { redirect } from "next/navigation";

// Token lookup is request-specific (legacy redirect); block prerendering.
export const instant = false;

/** Legacy waiting path; the project route is /interview/[token]/waiting. */
export default async function LegacyWaitingPage(
  props: PageProps<"/i/[token]/waiting">,
) {
  const { token } = await props.params;
  redirect(`/interview/${token}/waiting`);
}
