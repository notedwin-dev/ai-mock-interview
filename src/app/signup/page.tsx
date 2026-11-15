import type { Metadata } from "next";
import Link from "next/link";
import { SignUpForm } from "./SignUpForm";

export const metadata: Metadata = { title: "Create account · AIMIS" };

export default function SignUpPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <Link
        href="/"
        className="flex items-baseline gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 dark:focus-visible:ring-emerald-400"
      >
        <span className="font-display text-lg font-bold tracking-tight text-ink">
          AIMIS
        </span>
        <span className="text-xs text-ink-muted">practice studio</span>
      </Link>
      <div className="mt-6 w-full max-w-sm rounded-2xl border border-line bg-card p-8">
        <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
          Create account
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          One role per account: candidate or recruiter.
        </p>
        <div className="mt-6">
          <SignUpForm />
        </div>
        <p className="mt-6 text-sm text-ink-soft">
          Already registered?{" "}
          <Link
            href="/signin"
            className="font-medium text-emerald-700 underline decoration-emerald-600/40 underline-offset-2 outline-none transition-colors hover:text-emerald-800 dark:text-emerald-300 dark:decoration-emerald-400/40 dark:hover:text-emerald-200"
          >
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
