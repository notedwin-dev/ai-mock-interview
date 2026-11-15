import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = { title: "Sign in · AIMIS" };

/**
 * Auth surface, PrepWise-adapted: a centred card on the room grid, wordmark
 * above, labelled pill inputs inside, one clear primary action.
 */
export default function SignInPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <BrandMark href="/" />
      <div className="mt-8 w-full max-w-md rounded-3xl border border-line bg-surface p-8">
        <h1 className="text-center font-display text-2xl font-semibold tracking-tight text-ink">
          Practise job interviews with AI
        </h1>
        <p className="mt-1.5 text-center text-sm text-ink-muted">
          Access your practice studio.
        </p>
        <div className="mt-8">
          <SignInForm />
        </div>
        <p className="mt-8 text-center text-sm text-ink-muted">
          New to AIMIS?{" "}
          <Link
            href="/signup"
            className="font-medium text-emerald-400 outline-none transition-colors hover:text-emerald-300 focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            Create an account
          </Link>
        </p>
      </div>
    </main>
  );
}
