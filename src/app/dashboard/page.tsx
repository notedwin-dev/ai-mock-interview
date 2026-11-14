import { Suspense } from "react";
import { signOut } from "@/lib/auth";
import { requireAccount } from "@/lib/auth/guard";

async function signOutAction(): Promise<void> {
  "use server";
  await signOut({ redirectTo: "/" });
}

async function DashboardContent() {
  // Guards re-validate the account against the database on every request;
  // the account_role must match the candidate-only dashboard for now.
  const { account } = await requireAccount({ role: "candidate" });

  return (
    <div className="flex flex-col items-start gap-4">
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        Signed in as{" "}
        <span className="font-medium text-zinc-900 dark:text-zinc-100">
          {account.email}
        </span>{" "}
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          {account.accountRole}
        </span>
      </p>
      <form action={signOutAction}>
        <button
          type="submit"
          className="h-10 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        Dashboard
      </h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Milestone M1 placeholder — the interview workflow arrives in M2.
      </p>
      <div className="mt-8">
        <Suspense fallback={<p className="text-sm text-zinc-600">Loading…</p>}>
          <DashboardContent />
        </Suspense>
      </div>
    </main>
  );
}
