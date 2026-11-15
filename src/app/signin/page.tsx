import type { Metadata } from "next";
import Link from "next/link";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = { title: "Sign in · AIMIS" };

export default function SignInPage() {
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
          Sign in
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          Access your practice studio.
        </p>
        <div className="mt-6">
          <SignInForm />
        </div>
        <p className="mt-6 text-sm text-ink-soft">
          New to AIMIS?{" "}
          <Link
            href="/signup"
            className="font-medium text-emerald-700 underline decoration-emerald-600/40 underline-offset-2 outline-none transition-colors hover:text-emerald-800 dark:text-emerald-300 dark:decoration-emerald-400/40 dark:hover:text-emerald-200"
          >
            Create an account
          </Link>
        </p>
      </div>
    </main>
  );
}
