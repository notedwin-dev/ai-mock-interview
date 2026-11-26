import Link from "next/link";
import { notFound } from "next/navigation";
import { InvitationConfirmation } from "@/components/interview/InvitationConfirmation";
import { resolveInvitation } from "@/lib/interview/invitations";

// Token lookup is request-specific; render per request so the stream settles.
export const instant = false;

/**
 * Invitation entry (FR-SETUP-008): a token resolves exactly one interview's
 * confirmation details. No account session is required and no other data is
 * exposed; invalid/revoked links look identical to a missing page.
 */
export default async function InvitationPage(
  props: PageProps<"/i/[token]">,
) {
  const { token } = await props.params;
  const interview = await resolveInvitation(token);
  if (!interview) notFound();

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-10">
      <div className="mb-6 flex items-center gap-2 text-sm text-ink-muted">
        <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-xl border border-line bg-surface font-semibold text-ink">
          A
        </span>
        AIMIS invite
      </div>
      <InvitationConfirmation token={token} interview={interview} />
      <p className="mt-6 text-xs text-ink-muted">
        <Link href="/" className="underline decoration-line underline-offset-4 hover:text-ink">
          About AIMIS
        </Link>
      </p>
    </main>
  );
}
