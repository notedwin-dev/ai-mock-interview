"use server";

import { AuthError } from "next-auth";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { signIn, signOut } from "./index";
import { hashPassword } from "./password";
import { registrationSchema, type AuthFormState } from "./validation";

/**
 * Self-service registration (FR-AUTH-001/004). The account and its
 * role-owned profile are created atomically: an account must never exist
 * without the profile its role requires. Administrators are provisioned
 * out-of-band and cannot be created here.
 */
export async function registerAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = registrationSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    displayName: formData.get("displayName"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return { error: "Check the highlighted fields and try again." };
  }

  const passwordHash = await hashPassword(parsed.data.password);

  try {
    await db.$transaction(async (tx) => {
      const account = await tx.userAccount.create({
        data: {
          email: parsed.data.email,
          passwordHash,
          accountRole: parsed.data.role,
        },
      });
      if (parsed.data.role === "candidate") {
        await tx.candidateProfile.create({
          data: {
            userId: account.userId,
            displayName: parsed.data.displayName,
            skillsJson: [],
            educationJson: [],
            experienceJson: [],
            portfolioLinksJson: [],
          },
        });
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: "This email is already registered. Try signing in instead." };
    }
    console.error(
      "registration failed:",
      error instanceof Error ? error.message : String(error),
    );
    return { error: "Could not create the account. Please try again." };
  }

  // Registration succeeded: start the session immediately. A successful
  // signIn throws Next.js' internal NEXT_REDIRECT signal, which must
  // propagate untouched; Auth.js failures fall through to a manual sign-in.
  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo: "/dashboard",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return {
        error: "Account created, but automatic sign-in failed. Please sign in manually.",
      };
    }
    throw error;
  }
  return {};
}

/**
 * Credentials sign-in (FR-AUTH-002). Auth.js errors become form state;
 * everything else (including the NEXT_REDIRECT success signal) propagates.
 */
export async function authenticateAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/dashboard",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: "Invalid email or password." };
    }
    throw error;
  }
  return {};
}

/**
 * Signs the current session out and returns to the public home (companion to
 * FR-AUTH-002). The NEXT_REDIRECT thrown by signOut must propagate untouched.
 */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/" });
}
