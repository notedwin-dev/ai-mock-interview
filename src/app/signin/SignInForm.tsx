"use client";

import { useActionState } from "react";
import { authenticateAction } from "@/lib/auth/actions";
import type { AuthFormState } from "@/lib/auth/validation";

const initialState: AuthFormState = {};

const FIELD_CLASS =
  "h-11 rounded-full border border-transparent bg-raised px-5 text-sm text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-emerald-400/70 focus:ring-2 focus:ring-emerald-400/20";
const LABEL_CLASS = "text-sm font-medium text-ink-soft";

export function SignInForm() {
  const [state, formAction, pending] = useActionState(
    authenticateAction,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className={LABEL_CLASS}>
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className={FIELD_CLASS}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className={LABEL_CLASS}>
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className={FIELD_CLASS}
        />
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-red-400">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="mt-2 h-11 w-full cursor-pointer rounded-full bg-emerald-400 text-sm font-semibold text-emerald-950 outline-none transition-all hover:bg-emerald-300 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
