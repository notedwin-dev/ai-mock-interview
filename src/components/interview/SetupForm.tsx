"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  EVALUATION_MODES,
  RUNTIME_MODES,
  interviewSetupSchema,
  type EvaluationMode,
  type RuntimeMode,
} from "@/lib/interview/validation";
import type { InterviewCategorySummary } from "@/lib/interview/service";
import type { ProviderConfigSummary } from "@/lib/providers/config";

/**
 * Interview setup form (FR-SETUP-001..005, FR-INTERVIEW-001): one screen,
 * client-side validation against the shared zod contract (the same object the
 * server validates), then POST /api/v1/interviews; a 201 redirects into the
 * meeting room. Runtime mode renders as stacked, mutually exclusive cards
 * (FR-SETUP-005 acceptance wording).
 */

const fieldClassName =
  "h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
const labelClassName =
  "text-sm font-medium text-zinc-900 dark:text-zinc-100";

const EVALUATION_MODE_DESCRIPTIONS: Record<EvaluationMode, string> = {
  supportive: "Encouraging tone with gentler feedback.",
  balanced: "A mix of strengths and improvement points.",
  rigorous: "Direct critique against a high standard.",
};

const RUNTIME_MODE_DESCRIPTIONS: Record<RuntimeMode, string> = {
  preset_realtime: "Run on a pre-configured realtime agent runtime.",
  custom: "Run on your own configured ASR, LLM and TTS pipeline.",
};

/** Capabilities surfaced as readiness hints inside the custom-runtime card. */
const CAPABILITY_HINTS = ["asr", "llm", "tts"] as const;
type HintCapability = (typeof CAPABILITY_HINTS)[number];

const CAPABILITY_HINT_LABELS: Record<HintCapability, string> = {
  asr: "Speech recognition (ASR)",
  llm: "Interviewer (LLM)",
  tts: "Voice output (TTS)",
};

interface SetupFormProps {
  categories: InterviewCategorySummary[];
  configurations: ProviderConfigSummary[];
}

function cardClassName(selected: boolean): string {
  return `cursor-pointer rounded-lg border px-4 py-3 transition-colors ${
    selected
      ? "border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-800"
      : "border-zinc-300 hover:border-zinc-500 dark:border-zinc-700 dark:hover:border-zinc-500"
  }`;
}

export function SetupForm({ categories, configurations }: SetupFormProps) {
  const router = useRouter();
  const [jobRole, setJobRole] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [evaluationMode, setEvaluationMode] = useState<EvaluationMode | null>(
    null,
  );
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<{ code: string; message: string } | null>(
    null,
  );
  const [pending, setPending] = useState(false);

  const servingRow = (capability: HintCapability) =>
    configurations.find((row) => row.isEnabled && row.capabilities[capability]) ??
    null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    setSubmitError(null);

    const parsed = interviewSetupSchema.safeParse({
      jobRole,
      jobDescription: jobDescription.length > 0 ? jobDescription : undefined,
      categoryId,
      evaluationMode,
      runtimeMode,
    });
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form");
        if (!errors[key]) errors[key] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/v1/interviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = (await response.json().catch(() => null)) as
        | { session?: { sessionId?: string }; error?: { code: string; message: string } }
        | null;
      if (response.status === 201 && body?.session?.sessionId) {
        router.push(`/dashboard/interview/${body.session.sessionId}`);
        return;
      }
      setSubmitError(
        body?.error ?? {
          code: "unexpected_response",
          message: "Could not create the interview room. Try again.",
        },
      );
    } catch {
      setSubmitError({
        code: "network_error",
        message: "Could not reach the server. Try again.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <label htmlFor="jobRole" className={labelClassName}>
          Target job role
        </label>
        <input
          id="jobRole"
          name="jobRole"
          type="text"
          value={jobRole}
          onChange={(event) => setJobRole(event.target.value)}
          maxLength={150}
          required
          className={fieldClassName}
        />
        {fieldErrors.jobRole ? (
          <p className="text-xs text-red-700 dark:text-red-400">
            {fieldErrors.jobRole}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="jobDescription" className={labelClassName}>
          Job description (optional)
        </label>
        <textarea
          id="jobDescription"
          name="jobDescription"
          value={jobDescription}
          onChange={(event) => setJobDescription(event.target.value)}
          maxLength={8000}
          rows={5}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
        <div className="flex items-baseline justify-between gap-4">
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Pasted here, it is used to contextualise the interview questions.
          </p>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {jobDescription.length}/8000
          </span>
        </div>
        {fieldErrors.jobDescription ? (
          <p className="text-xs text-red-700 dark:text-red-400">
            {fieldErrors.jobDescription}
          </p>
        ) : null}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className={labelClassName}>Interview category</legend>
        {categories.map((category) => (
          <label
            key={category.categoryId}
            className={cardClassName(categoryId === category.categoryId)}
          >
            <input
              type="radio"
              name="categoryId"
              value={category.categoryId}
              checked={categoryId === category.categoryId}
              onChange={() => setCategoryId(category.categoryId)}
              className="sr-only"
            />
            <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {category.categoryName}
            </span>
            {category.description ? (
              <span className="block text-xs text-zinc-600 dark:text-zinc-400">
                {category.description}
              </span>
            ) : null}
          </label>
        ))}
        {fieldErrors.categoryId ? (
          <p className="text-xs text-red-700 dark:text-red-400">
            {fieldErrors.categoryId}
          </p>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className={labelClassName}>Evaluation mode</legend>
        {EVALUATION_MODES.map((mode) => (
          <label
            key={mode}
            className={cardClassName(evaluationMode === mode)}
          >
            <input
              type="radio"
              name="evaluationMode"
              value={mode}
              checked={evaluationMode === mode}
              onChange={() => setEvaluationMode(mode)}
              className="sr-only"
            />
            <span className="block text-sm font-medium capitalize text-zinc-900 dark:text-zinc-100">
              {mode}
            </span>
            <span className="block text-xs text-zinc-600 dark:text-zinc-400">
              {EVALUATION_MODE_DESCRIPTIONS[mode]}
            </span>
          </label>
        ))}
        {fieldErrors.evaluationMode ? (
          <p className="text-xs text-red-700 dark:text-red-400">
            {fieldErrors.evaluationMode}
          </p>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className={labelClassName}>Runtime mode</legend>
        {RUNTIME_MODES.map((mode) => (
          <label
            key={mode}
            className={cardClassName(runtimeMode === mode)}
          >
            <input
              type="radio"
              name="runtimeMode"
              value={mode}
              checked={runtimeMode === mode}
              onChange={() => setRuntimeMode(mode)}
              className="sr-only"
            />
            <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {mode === "preset_realtime"
                ? "Pre-configured Realtime Agents"
                : "Custom Configuration"}
            </span>
            <span className="block text-xs text-zinc-600 dark:text-zinc-400">
              {RUNTIME_MODE_DESCRIPTIONS[mode]}
            </span>
          </label>
        ))}
        {runtimeMode === "custom" ? (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
              Pipeline readiness
            </p>
            <ul className="mt-2 flex flex-col gap-1">
              {CAPABILITY_HINTS.map((capability) => {
                const row = servingRow(capability);
                return (
                  <li
                    key={capability}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="text-zinc-600 dark:text-zinc-400">
                      {CAPABILITY_HINT_LABELS[capability]}
                    </span>
                    {row ? (
                      <span className="text-zinc-600 dark:text-zinc-400">
                        {row.providerName} · {row.credentialStatus}
                      </span>
                    ) : (
                      <span className="text-zinc-600 dark:text-zinc-400">
                        Not configured —{" "}
                        <Link
                          href="/dashboard/profile"
                          className="underline hover:text-zinc-900 dark:hover:text-zinc-100"
                        >
                          configure
                        </Link>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {fieldErrors.runtimeMode ? (
          <p className="text-xs text-red-700 dark:text-red-400">
            {fieldErrors.runtimeMode}
          </p>
        ) : null}
      </fieldset>

      {submitError ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
          {submitError.message}
          {submitError.code === "provider_route_missing" ? (
            <>
              {" "}
              <Link
                href="/dashboard/profile"
                className="font-medium underline"
              >
                Configure a provider
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-zinc-50 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {pending ? "Creating room…" : "Create interview room"}
      </button>
    </form>
  );
}
