import { redirect } from "next/navigation";

/** Legacy invitation path; the project route is /interview/[token]. */
export default async function LegacyInvitationPage(
  props: PageProps<"/i/[token]">,
) {
  const { token } = await props.params;
  redirect(`/interview/${token}`);
}
