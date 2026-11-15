"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/lib/auth/actions";

/**
 * Practice-studio navigation, desktop-first: a sticky full-height rail on lg
 * screens (wordmark, section nav, primary CTA, account block) that collapses
 * to a top bar below lg. The rail marks the active section and hides the
 * "New interview" CTA inside the interview flow (setup wizard and room),
 * where starting another session would be noise. A client component because
 * active state follows the live pathname.
 */

const NAV_ITEMS = [
  {
    href: "/dashboard",
    label: "Dashboard",
    isActive: (pathname: string) => pathname === "/dashboard",
  },
  {
    href: "/dashboard/profile",
    label: "Profile",
    isActive: (pathname: string) => pathname.startsWith("/dashboard/profile"),
  },
] as const;

interface NavRailProps {
  email: string;
}

export function NavRail({ email }: NavRailProps) {
  const pathname = usePathname();
  const inInterviewFlow = pathname.startsWith("/dashboard/interview");

  return (
    <aside className="sticky top-0 z-20 flex shrink-0 flex-row items-center justify-between gap-3 border-b border-line bg-paper/95 px-5 py-3 backdrop-blur lg:h-dvh lg:w-64 lg:flex-col lg:items-stretch lg:border-b-0 lg:border-r lg:bg-transparent lg:px-6 lg:py-9">
      <Link
        href="/dashboard"
        className="flex shrink-0 flex-row items-baseline gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 lg:flex-col lg:items-start lg:gap-0.5 dark:focus-visible:ring-emerald-400"
      >
        <span className="font-display text-lg font-bold tracking-tight text-ink">
          AIMIS
        </span>
        <span className="text-xs text-ink-muted">practice studio</span>
      </Link>

      <nav
        aria-label="Primary"
        className="flex items-center gap-1 lg:mt-14 lg:flex-col lg:items-stretch lg:gap-1.5"
      >
        {NAV_ITEMS.map((item) => {
          const active = item.isActive(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium outline-none transition-all focus-visible:ring-2 focus-visible:ring-emerald-700 active:scale-[0.97] dark:focus-visible:ring-emerald-400 ${
                active
                  ? "bg-stage text-stage-text"
                  : "text-ink-soft hover:bg-card hover:text-ink"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
        {!inInterviewFlow ? (
          <Link
            href="/dashboard/interview/new"
            className="hidden h-10 shrink-0 cursor-pointer items-center rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white outline-none transition-all hover:bg-emerald-800 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 lg:mt-8 lg:inline-flex dark:focus-visible:ring-emerald-400 dark:focus-visible:ring-offset-paper"
          >
            New interview
          </Link>
        ) : null}
      </nav>

      <div className="flex shrink-0 items-center gap-3 lg:mt-auto lg:flex-col lg:items-stretch lg:border-t lg:border-line lg:pt-5">
        <span className="hidden truncate text-xs text-ink-muted lg:block">
          {email}
        </span>
        <form action={signOutAction}>
          <button
            type="submit"
            className="cursor-pointer text-sm font-medium text-ink-soft outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-emerald-700 dark:focus-visible:ring-emerald-400"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
