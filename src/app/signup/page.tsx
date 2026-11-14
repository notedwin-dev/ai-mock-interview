import type { Metadata } from "next";
import Link from "next/link";
import { SignUpForm } from "./SignUpForm";

export const metadata: Metadata = { title: "Create account · AIMIS" };

export default function SignUpPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          Create account
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          One role per account: candidate or recruiter.
        </p>
        <div className="mt-6">
          <SignUpForm />
        </div>
        <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">
          Already registered?{" "}
          <Link
            href="/signin"
            className="font-medium text-zinc-900 underline underline-offset-2 dark:text-zinc-50"
          >
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
