"use client";

import { useActionState } from "react";
import { registerAction } from "@/lib/auth/actions";
import type { AuthFormState } from "@/lib/auth/validation";

const initialState: AuthFormState = {};

const fieldClassName =
  "h-10 rounded-lg border border-line bg-card px-3 text-sm text-ink outline-none transition-colors focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 dark:focus:border-emerald-400 dark:focus:ring-emerald-400/20";
const labelClassName = "text-sm font-medium text-ink";

export function SignUpForm() {
  const [state, formAction, pending] = useActionState(
    registerAction,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="displayName" className={labelClassName}>
          Display name
        </label>
        <input
          id="displayName"
          name="displayName"
          type="text"
          required
          maxLength={100}
          autoComplete="name"
          className={fieldClassName}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="email" className={labelClassName}>
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className={fieldClassName}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="password" className={labelClassName}>
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className={fieldClassName}
        />
        <p className="text-xs text-ink-muted">
          At least 8 characters with a letter and a digit.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="role" className={labelClassName}>
          Role
        </label>
        <select id="role" name="role" defaultValue="candidate" className={fieldClassName}>
          <option value="candidate">Candidate — practise interviews</option>
          <option value="recruiter">Recruiter — discover public profiles</option>
        </select>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="h-10 cursor-pointer rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white outline-none transition-all hover:bg-emerald-800 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-emerald-400"
      >
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
