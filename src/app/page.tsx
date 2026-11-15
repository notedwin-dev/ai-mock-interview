import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "AIMIS — the green room for your next interview",
};

/**
 * Public landing page. The hero states the product's role in the
 * performer's vocabulary: the green room is where you prepare before you
 * go on. One dark stage panel, display type, two actions — no decoration.
 */
export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16 sm:py-24">
      <section className="w-full max-w-2xl rounded-2xl bg-stage p-8 text-stage-text sm:p-12">
        <p className="flex items-baseline gap-2.5">
          <span className="font-display text-lg font-bold tracking-tight text-stage-text">
            AIMIS
          </span>
          <span className="text-xs text-stage-muted">practice studio</span>
        </p>
        <h1 className="mt-8 font-display text-3xl font-semibold tracking-tight text-stage-text sm:text-4xl">
          The green room for your next interview.
        </h1>
        <p className="mt-4 max-w-md text-sm leading-relaxed text-stage-muted sm:text-base">
          Set up a mock interview, step into the room, and answer the AI
          interviewer&apos;s questions. Your transcript stays with you for
          review.
        </p>
        <nav className="mt-9 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/signin"
            className="inline-flex h-11 cursor-pointer items-center justify-center rounded-lg bg-emerald-400 px-5 text-sm font-semibold text-emerald-950 outline-none transition-all hover:bg-emerald-300 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-emerald-200 focus-visible:ring-offset-2 focus-visible:ring-offset-stage"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="inline-flex h-11 cursor-pointer items-center justify-center rounded-lg border border-stage-border px-5 text-sm font-semibold text-stage-text outline-none transition-colors hover:border-stage-muted active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-emerald-200 focus-visible:ring-offset-2 focus-visible:ring-offset-stage"
          >
            Create account
          </Link>
        </nav>
      </section>
    </main>
  );
}
