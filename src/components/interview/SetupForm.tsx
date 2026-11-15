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
 * Interview setup form (FR-SETUP-001..005, FR-INTERVIEW-001), reference-design-
 * adapted: one screen, question-style labels, pill/select controls, client-
 * side validation against the shared zod contract (the same object the
 * server validates), then POST /api/v1/interviews; a 201 redirects into the
 * meeting room. Runtime mode renders as stacked, mutually exclusive cards
 * (FR-SETUP-005 acceptance wording).
 */

const FIELD_CLASS =
  "h-11 rounded-full border border-transparent bg-raised px-5 text-sm text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-emerald-400/70 focus:ring-2 focus:ring-emerald-400/20";
const LABEL_CLASS = "text-sm font-medium text-ink";
const ERROR_CLASS = "text-xs text-red-400";

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

/** Plain-language wording for credential states in readiness hints. */
const CREDENTIAL_STATUS_WORDS: Record<string, string> = {
  valid: "validated",
  unvalidated: "not validated yet",
  invalid: "check failed",
};

interface SetupFormProps {
  categories: InterviewCategorySummary[];
  configurations: ProviderConfigSummary[];
}

function cardClassName(selected: boolean): string {
  return `cursor-pointer rounded-2xl border px-4 py-3 transition-colors ${
    selected
      ? "border-emerald-400 bg-emerald-400/10"
      : "border-line hover:border-ink-muted"
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
      <div className="flex flex-col gap-1.5">
        <label htmlFor="jobRole" className={LABEL_CLASS}>
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
          placeholder="Select the role you want to practise"
          className={FIELD_CLASS}
        />
        {fieldErrors.jobRole ? (
          <p className={ERROR_CLASS}>{fieldErrors.jobRole}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="jobDescription" className={LABEL_CLASS}>
          Job description (optional)
        </label>
        <textarea
          id="jobDescription"
          name="jobDescription"
          value={jobDescription}
          onChange={(event) => setJobDescription(event.target.value)}
          maxLength={8000}
          rows={5}
          placeholder="Paste the description here; it is used to contextualise the questions."
          className="rounded-2xl border border-transparent bg-raised px-5 py-3.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-emerald-400/70 focus:ring-2 focus:ring-emerald-400/20"
        />
        <div className="flex items-baseline justify-between gap-4">
          {fieldErrors.jobDescription ? (
            <p className={ERROR_CLASS}>{fieldErrors.jobDescription}</p>
          ) : (
            <span />
          )}
          <span className="text-xs text-ink-muted">
            {jobDescription.length}/8000
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="categoryId" className={LABEL_CLASS}>
          What type of interview would you like to practise?
        </label>
        <select
          id="categoryId"
          name="categoryId"
          value={categoryId ?? ""}
          onChange={(event) => setCategoryId(event.target.value || null)}
          className={FIELD_CLASS}
        >
          <option value="" disabled>
            Select an interview type
          </option>
          {categories.map((category) => (
            <option key={category.categoryId} value={category.categoryId}>
              {category.categoryName}
            </option>
          ))}
        </select>
        {fieldErrors.categoryId ? (
          <p className={ERROR_CLASS}>{fieldErrors.categoryId}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="evaluationMode" className={LABEL_CLASS}>
          How should the interviewer treat you?
        </label>
        <select
          id="evaluationMode"
          name="evaluationMode"
          value={evaluationMode ?? ""}
          onChange={(event) =>
            setEvaluationMode(
              (event.target.value || null) as EvaluationMode | null,
            )
          }
          className={FIELD_CLASS}
        >
          <option value="" disabled>
            Select an evaluation mode
          </option>
          {EVALUATION_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </option>
          ))}
        </select>
        <p className="text-xs text-ink-muted">
          {evaluationMode
            ? EVALUATION_MODE_DESCRIPTIONS[evaluationMode]
            : "Choose how much pressure the feedback should carry."}
        </p>
        {fieldErrors.evaluationMode ? (
          <p className={ERROR_CLASS}>{fieldErrors.evaluationMode}</p>
        ) : null}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className={LABEL_CLASS}>How should the room run?</legend>
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
            <span className="block text-sm font-medium text-ink">
              {mode === "preset_realtime"
                ? "Pre-configured Realtime Agents"
                : "Custom Configuration"}
            </span>
            <span className="mt-0.5 block text-xs text-ink-muted">
              {RUNTIME_MODE_DESCRIPTIONS[mode]}
            </span>
          </label>
        ))}
        {runtimeMode === "custom" ? (
          <div className="rounded-2xl border border-line bg-raised px-4 py-3">
            <p className="text-xs font-medium text-ink-soft">
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
                    <span className="text-ink-muted">
                      {CAPABILITY_HINT_LABELS[capability]}
                    </span>
                    {row ? (
                      <span className="text-ink-soft">
                        {row.providerName},{" "}
                        {CREDENTIAL_STATUS_WORDS[row.credentialStatus] ??
                          row.credentialStatus}
                      </span>
                    ) : (
                      <span className="text-ink-muted">
                        Not set up,{" "}
                        <Link
                          href="/dashboard/profile"
                          className="font-medium text-emerald-400 underline underline-offset-2 outline-none transition-colors hover:text-emerald-300"
                        >
                          set it up
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
          <p className={ERROR_CLASS}>{fieldErrors.runtimeMode}</p>
        ) : null}
      </fieldset>

      {submitError ? (
        <p className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
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
        className="h-11 w-full cursor-pointer rounded-full bg-emerald-400 text-sm font-semibold text-emerald-950 outline-none transition-all hover:bg-emerald-300 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Creating room…" : "Create interview room"}
      </button>
    </form>
  );
}
