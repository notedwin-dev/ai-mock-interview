import type { Metadata } from "next";
import Link from "next/link";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = { title: "Sign in · AIMIS" };

export default function SignInPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          Sign in
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Access your AIMIS account.
        </p>
        <div className="mt-6">
          <SignInForm />
        </div>
        <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">
          New to AIMIS?{" "}
          <Link
            href="/signup"
            className="font-medium text-zinc-900 underline underline-offset-2 dark:text-zinc-50"
          >
            Create an account
          </Link>
        </p>
      </div>
    </main>
  );
}
