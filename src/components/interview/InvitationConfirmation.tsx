import Link from "next/link";
import type { InvitationView } from "@/lib/interview/invitations";

/** Review-and-confirm step shown before the waiting room (FR-SETUP-007/008). */
export function InvitationConfirmation({
  token,
  interview,
}: {
  token: string;
  interview: InvitationView;
}) {
  const canJoin = interview.status === "scheduled";

  return (
    <section className="rounded-3xl border border-line bg-surface p-6 sm:p-8">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
        Your mock interview is ready
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        Review the details below. The interview starts only after you choose to
        join in the waiting room — opening this link never starts it.
      </p>
      <dl className="mt-6 grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-ink-muted">Target role</dt>
          <dd className="mt-0.5 text-sm text-ink">{interview.jobRole}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-ink-muted">Category</dt>
          <dd className="mt-0.5 text-sm text-ink">{interview.categoryNameSnapshot}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-ink-muted">Evaluation mode</dt>
          <dd className="mt-0.5 text-sm text-ink capitalize">{interview.evaluationMode}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-ink-muted">Status</dt>
          <dd className="mt-0.5 text-sm text-ink capitalize">{interview.status}</dd>
        </div>
        {interview.jobDescription ? (
          <div className="sm:col-span-2">
            <dt className="text-xs uppercase tracking-wide text-ink-muted">Job description</dt>
            <dd className="mt-0.5 whitespace-pre-wrap text-sm text-ink">{interview.jobDescription}</dd>
          </div>
        ) : null}
      </dl>
      {canJoin ? (
        <Link
          href={`/i/${token}/waiting`}
          className="mt-8 inline-flex h-11 items-center rounded-full bg-emerald-400 px-6 text-sm font-semibold text-emerald-950 outline-none transition-all hover:bg-emerald-300 focus-visible:ring-2 focus-visible:ring-emerald-400"
        >
          Continue to waiting room
        </Link>
      ) : (
        <p className="mt-8 text-sm text-amber-300">
          This interview has already started or ended, so it cannot be joined from this link.
        </p>
      )}
    </section>
  );
}
