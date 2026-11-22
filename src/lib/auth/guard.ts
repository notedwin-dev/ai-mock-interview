import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { Session } from "next-auth";
import type { UserAccount } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { auth } from "./index";

export interface GuardedAccount {
  session: Session;
  account: UserAccount;
}

/**
 * Resolves the caller's account, re-validating it against the database on
 * every use: the JWT proves identity, but account_status and account_role are
 * authoritative in the database (FR-AUTH-004/005). A stale or forged token, a
 * pending_deletion/deactivated account, or a role change must not grant
 * access.
 *
 * - No session / locked-out account → redirect to /signin.
 * - Role mismatch (when `options.role` is given) → redirect to /.
 *
 * The `connection()` call makes the whole subtree per-request dynamic
 * (docs: Cache Components → random values and request-time data): the
 * speculative prerender pass stops here, so Auth.js's session machinery
 * (which calls crypto.getRandomValues()) is never evaluated while
 * prerendering the static shell. Callers must still place
 * requireAccount() inside a <Suspense> boundary.
 */
export async function requireAccount(
  options: { role?: string } = {},
): Promise<GuardedAccount> {
  await connection();

  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const account = await db.userAccount.findUnique({
    where: { userId: session.user.id },
  });
  if (!account || account.accountStatus !== "active") redirect("/signin");

  if (options.role !== undefined && account.accountRole !== options.role) {
    redirect("/");
  }

  return { session, account };
}

/**
 * Route-handler variant: same database-backed identity, status and role
 * checks, but resolves null instead of redirecting so /api/v1 handlers can
 * answer with JSON 401/403 (FR-AUTH-005 semantics, JSON surface).
 */
export async function requireApiAccount(
  options: { role?: string } = {},
): Promise<GuardedAccount | null> {
  await connection();

  const session = await auth();
  if (!session?.user?.id) return null;

  const account = await db.userAccount.findUnique({
    where: { userId: session.user.id },
  });
  if (!account || account.accountStatus !== "active") return null;

  if (options.role !== undefined && account.accountRole !== options.role) {
    return null;
  }

  return { session, account };
}
