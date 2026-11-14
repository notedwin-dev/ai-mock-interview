import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-24 text-center">
      <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        AIMIS
      </h1>
      <p className="max-w-md text-lg text-zinc-600 dark:text-zinc-400">
        Web-based AI-assisted mock interview simulation and feedback system.
      </p>
      <nav className="flex gap-3">
        <Link
          href="/signin"
          className="flex h-11 items-center rounded-md bg-zinc-900 px-5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Sign in
        </Link>
        <Link
          href="/signup"
          className="flex h-11 items-center rounded-md border border-zinc-300 px-5 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          Create account
        </Link>
      </nav>
    </main>
  );
}
