import Link from "next/link";

/** Shared top shell for token-scoped interview pages (desktop included). */
export function RoomHeader({ title, backHref = "/dashboard" }: { title: string; backHref?: string }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-app/85 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-[80rem] items-center justify-between gap-4 px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-4">
          <Link href="/dashboard" className="flex items-center gap-2 font-display font-bold text-ink">
            <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-400 text-emerald-950">A</span>
            AIMIS
          </Link>
          <span className="hidden text-sm text-ink-muted sm:inline">{title}</span>
        </div>
        <Link
          href={backHref}
          className="rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium text-ink-soft transition-colors hover:border-ink-muted hover:text-ink"
        >
          ← Back to dashboard
        </Link>
      </div>
    </header>
  );
}
