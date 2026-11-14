import NextAuth from "next-auth";
import { authConfig } from "./config";

/**
 * Auth.js v5 entry point. AUTH_SECRET is read from the environment by
 * Auth.js itself at request time; see src/lib/auth/env.ts for the validated
 * fail-fast surface used inside our own code paths.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
