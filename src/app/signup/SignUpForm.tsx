"use client";

import { useActionState } from "react";
import { registerAction } from "@/lib/auth/actions";
import type { AuthFormState } from "@/lib/auth/validation";

const initialState: AuthFormState = {};

const fieldClassName =
  "h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
const labelClassName =
  "text-sm font-medium text-zinc-900 dark:text-zinc-100";

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
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
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
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="h-10 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
