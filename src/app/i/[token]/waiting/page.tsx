import { redirect } from "next/navigation";

/** Legacy waiting path; the project route is /interview/[token]/waiting. */
export default async function LegacyWaitingPage(
  props: PageProps<"/i/[token]/waiting">,
) {
  const { token } = await props.params;
  redirect(`/interview/${token}/waiting`);
}
