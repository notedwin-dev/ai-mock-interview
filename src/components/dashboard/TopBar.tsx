"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/lib/auth/actions";
import { BrandMark } from "@/components/BrandMark";

/**
 * Dashboard shell navigation (round 4, reference-design-adapted): a sticky top bar —
 * wordmark left, section pills beside it, account block right. Marks the
 * active section from the live pathname; a client component for that reason.
 */

const NAV_ITEMS = [
  {
    href: "/dashboard",
    label: "Dashboard",
    isActive: (pathname: string) => pathname === "/dashboard",
  },
  {
    href: "/dashboard/configuration",
    label: "Configuration",
    isActive: (pathname: string) => pathname.startsWith("/dashboard/configuration"),
  },
  {
    href: "/dashboard/profile",
    label: "Profile",
    isActive: (pathname: string) => pathname.startsWith("/dashboard/profile"),
  },
] as const;

interface TopBarProps {
  email: string;
}

export function TopBar({ email }: TopBarProps) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-app/80 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-[80rem] items-center justify-between gap-4 px-6 lg:px-10">
        <div className="flex min-w-0 items-center gap-6">
          <BrandMark href="/dashboard" />
          <nav aria-label="Primary" className="flex items-center gap-1">
            {NAV_ITEMS.map((item) => {
              const active = item.isActive(pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  // Provider state changes on every save/probe/mode switch;
                  // a prefetched RSC payload would show deleted rows and hide
                  // fresh probe results after navigating back here.
                  prefetch={false}
                  aria-current={active ? "page" : undefined}
                  className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                    active
                      ? "bg-raised text-ink"
                      : "text-ink-soft hover:bg-raised/60 hover:text-ink"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden max-w-52 truncate text-sm text-ink-muted md:block">
            {email}
          </span>
          <span
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-raised text-xs font-semibold text-ink-soft"
          >
            {email.slice(0, 1).toUpperCase()}
          </span>
          <form action={signOutAction}>
            <button
              type="submit"
              className="cursor-pointer rounded-full px-2 py-1.5 text-sm font-medium text-ink-soft outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
