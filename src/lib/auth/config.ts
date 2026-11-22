import { randomUUID } from "node:crypto";
import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { db } from "@/lib/db";
import { getAuthEnv } from "./env";
import { hashPassword, verifyPassword } from "./password";
import { credentialsSchema } from "./validation";

/**
 * Unknown email → run one dummy Argon2 verification so the response time does
 * not reveal which email addresses are registered (user-enumeration timing
 * signal). The hash is generated once and reused.
 */
let dummyHash: Promise<string> | null = null;
async function consumeDummyVerification(): Promise<null> {
  dummyHash ??= hashPassword(`aimis-unknown-account-${randomUUID()}`);
  await verifyPassword(await dummyHash, "aimis-unknown-account");
  return null;
}

export const authConfig: NextAuthConfig = {
  // Self-hosted production runs behind the compose nginx proxy: trust the
  // Host header only when AUTH_TRUST_HOST=true (docs/ENVIRONMENT.md).
  // Development (`next dev` on localhost) is trusted by default.
  trustHost:
    process.env["NODE_ENV"] !== "production" ||
    process.env["AUTH_TRUST_HOST"] === "true",
  session: { strategy: "jwt" },
  pages: { signIn: "/signin" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        // Fail fast on the first auth feature use if the environment is
        // misconfigured — deliberately not at module load, so builds and
        // unit tests never require auth secrets.
        getAuthEnv();

        const parsed = credentialsSchema.safeParse(credentials ?? {});
        if (!parsed.success) return null;

        const account = await db.userAccount.findUnique({
          where: { email: parsed.data.email },
        });
        if (!account) return consumeDummyVerification();

        // Only active accounts may authenticate: pending_deletion and
        // deactivated accounts are locked out even with valid credentials.
        if (account.accountStatus !== "active") return null;

        if (
          !(await verifyPassword(account.passwordHash, parsed.data.password))
        ) {
          return null;
        }

        return {
          id: account.userId,
          email: account.email,
          role: account.accountRole,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // user is only present on the initial credentials sign-in; afterwards
      // the role rides along inside the signed JWT.
      if (user) {
        token.sub = user.id;
        token.role = user.role;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.sub ?? "";
      session.user.role = typeof token.role === "string" ? token.role : "";
      return session;
    },
  },
};
