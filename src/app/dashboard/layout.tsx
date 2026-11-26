import { requireAccount } from "@/lib/auth/guard";
import { TopBar } from "@/components/dashboard/TopBar";

/**
 * Candidate dashboard shell: a sticky top bar (identity, section navigation,
 * sign-out) over a room-grid backdrop; each page renders pure content.
 *
 * The guard runs here so every dashboard route is protected at the server
 * boundary; pages re-guard because they need the account record. The shell
 * needs the account before anything meaningful can render (identity in the
 * bar, role gate for access), so this segment opts out of instant-navigation
 * validation via the blocking-route pattern for auth-gated layouts: the page
 * renders on every request and the navigation blocks until the guard
 * completes (docs: messages/blocking-prerender-dynamic → allow-blocking-route).
 *
 * The per-page `instant = false` exports in the dashboard tree are retained
 * alongside this one: an ancestor's `false` only exempts navigations into the
 * segment from outside — navigations between sibling segments below it are
 * still validated, and each of those pages blocks on the same guard
 * (instant.md: "Navigations between sibling segments below are still
 * validated").
 */
export const instant = false;

export default async function DashboardLayout({
  children,
}: LayoutProps<"/dashboard">) {
  const { account } = await requireAccount({ role: "candidate" });

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar email={account.email} />
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}
