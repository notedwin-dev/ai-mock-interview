import { requireAccount } from "@/lib/auth/guard";
import { NavRail } from "@/components/dashboard/NavRail";

/**
 * Candidate dashboard shell (desktop-first): a sticky navigation rail on lg
 * screens that collapses to a top bar on small ones. The shell owns identity,
 * navigation, the primary CTA placement and sign-out, so each page renders
 * pure content.
 *
 * The guard runs here so every dashboard route is protected at the server
 * boundary; pages re-guard because they need the account record. The shell
 * needs the account before anything meaningful can render (identity in the
 * rail, role gate for access), so this segment opts out of instant-navigation
 * validation via the blocking-route pattern for auth-gated layouts: the page
 * renders on every request and the navigation blocks until the guard
 * completes (docs: messages/blocking-prerender-dynamic → allow-blocking-route).
 */
export const instant = false;

export default async function DashboardLayout({
  children,
}: LayoutProps<"/dashboard">) {
  const { account } = await requireAccount({ role: "candidate" });

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <NavRail email={account.email} />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
