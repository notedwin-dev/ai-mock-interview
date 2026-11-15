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
    <aside className="sticky top-0 z-20 flex shrink-0 flex-row items-center justify-between gap-3 border-b border-stone-200 bg-stone-50/95 px-5 py-3 backdrop-blur lg:h-dvh lg:w-64 lg:flex-col lg:items-stretch lg:border-b-0 lg:border-r lg:bg-transparent lg:px-6 lg:py-9 dark:border-stone-800 dark:bg-stone-950/95 lg:dark:bg-transparent">
      <Link
        href="/dashboard"
        className="flex shrink-0 flex-row items-baseline gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-teal-600 lg:flex-col lg:items-start lg:gap-0.5 dark:focus-visible:ring-teal-300"
      >
        <span className="font-display text-lg font-bold tracking-tight text-stone-900 dark:text-stone-50">
          AIMIS
        </span>
        <span className="text-xs text-stone-500 dark:text-stone-400">
          practice studio
        </span>
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
              className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium outline-none transition-all focus-visible:ring-2 focus-visible:ring-teal-600 active:scale-[0.97] dark:focus-visible:ring-teal-300 ${
                active
                  ? "bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900"
                  : "text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
        {!inInterviewFlow ? (
          <Link
            href="/dashboard/interview/new"
            className="hidden h-10 shrink-0 cursor-pointer items-center rounded-lg bg-teal-700 px-4 text-sm font-semibold text-white outline-none transition-all hover:bg-teal-800 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2 lg:mt-8 lg:inline-flex dark:bg-teal-400 dark:text-stone-950 dark:hover:bg-teal-300 dark:focus-visible:ring-teal-200 dark:focus-visible:ring-offset-2"
          >
            New interview
          </Link>
        ) : null}
      </nav>

      <div className="flex shrink-0 items-center gap-3 lg:mt-auto lg:flex-col lg:items-stretch lg:border-t lg:border-stone-200 lg:pt-5 dark:lg:border-stone-800">
        <span className="hidden truncate text-xs text-stone-500 lg:block dark:text-stone-400">
          {email}
        </span>
        <form action={signOutAction}>
          <button
            type="submit"
            className="cursor-pointer text-sm font-medium text-stone-600 outline-none transition-colors hover:text-stone-900 focus-visible:ring-2 focus-visible:ring-teal-600 dark:text-stone-400 dark:hover:text-stone-100 dark:focus-visible:ring-teal-300"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
