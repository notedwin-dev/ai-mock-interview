"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";

export interface ConfirmableConfig {
  jobRole: string;
  jobDescription: string;
  experienceLevel?: string;
  techStack?: string[];
  questionCount?: number;
  strictness: "supportive" | "balanced" | "rigorous";
  category: "general" | "technical" | "behavioral";
}

/**
 * Structured double-confirm of the AI-generated interview. The candidate
 * reviews and can amend the object before it is applied to the session.
 */
export function GenerationConfirmation({
  config,
  onConfirm,
}: {
  config: ConfirmableConfig;
  onConfirm: (config: ConfirmableConfig) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ConfirmableConfig>(config);
  // Raw text drafts: normalising on every keystroke would strip a trailing
  // comma and make "React, " impossible to type. Both are normalised on blur
  // and again before confirmation.
  const [techStackDraft, setTechStackDraft] = useState((config.techStack ?? []).join(", "));
  const [questionCountDraft, setQuestionCountDraft] = useState(
    config.questionCount == null ? "" : String(config.questionCount),
  );
  const [fieldErrors, setFieldErrors] = useState<{ questionCount?: string }>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function normalizeTechStack(): string[] {
    const normalized = techStackDraft.split(",").map((part) => part.trim()).filter(Boolean);
    setTechStackDraft(normalized.join(", "));
    return normalized;
  }

  async function submit() {
    const rawCount = questionCountDraft.trim();
    let questionCount: number | undefined;
    if (rawCount !== "") {
      const parsed = Number(rawCount);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
        setFieldErrors({ questionCount: "Enter a whole number of questions between 1 and 50." });
        return;
      }
      questionCount = parsed;
    }
    setFieldErrors({});
    const finalConfig: ConfirmableConfig = {
      ...draft,
      techStack: normalizeTechStack(),
      questionCount,
    };
    setDraft(finalConfig);
    setPending(true);
    setError(null);
    try {
      await onConfirm(finalConfig);
    } catch {
      setError("Could not save the changes. Please try again.");
      setPending(false);
    }
  }

  return (
    <section className="rounded-3xl border border-line bg-surface p-6">
      <h2 className="font-display text-xl font-semibold text-ink">Confirm your interview</h2>
      <p className="mt-2 text-sm text-ink-muted">
        The planner generated this structured setup. Review it before opening the waiting room.
      </p>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-ink-muted">Target role</span>
          <input
            className="h-10 rounded-full border border-line bg-raised px-4 text-sm text-ink"
            value={draft.jobRole}
            onChange={(event) => setDraft({ ...draft, jobRole: event.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-ink-muted">Experience level</span>
          <input
            className="h-10 rounded-full border border-line bg-raised px-4 text-sm text-ink"
            value={draft.experienceLevel ?? ""}
            onChange={(event) => setDraft({ ...draft, experienceLevel: event.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-ink-muted">Topics (comma separated)</span>
          <input
            className="h-10 rounded-full border border-line bg-raised px-4 text-sm text-ink"
            value={techStackDraft}
            onChange={(event) => setTechStackDraft(event.target.value)}
            onBlur={() => setDraft((current) => ({ ...current, techStack: normalizeTechStack() }))}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-ink-muted">Questions</span>
          <input
            type="number"
            min={1}
            max={50}
            className="h-10 rounded-full border border-line bg-raised px-4 text-sm text-ink"
            value={questionCountDraft}
            onChange={(event) => {
              setQuestionCountDraft(event.target.value);
              if (fieldErrors.questionCount) setFieldErrors({});
            }}
            aria-invalid={Boolean(fieldErrors.questionCount)}
            aria-describedby={fieldErrors.questionCount ? "question-count-error" : undefined}
          />
          {fieldErrors.questionCount ? (
            <p id="question-count-error" className="text-xs text-red-400" role="alert">
              {fieldErrors.questionCount}
            </p>
          ) : null}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-ink-muted">Evaluation mode</span>
          <select
            className="h-10 rounded-full border border-line bg-raised px-4 text-sm text-ink"
            value={draft.strictness}
            onChange={(event) =>
              setDraft({ ...draft, strictness: event.target.value as ConfirmableConfig["strictness"] })
            }>
            <option value="supportive">Supportive</option>
            <option value="balanced">Balanced</option>
            <option value="rigorous">Rigorous</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-ink-muted">Category</span>
          <select
            className="h-10 rounded-full border border-line bg-raised px-4 text-sm text-ink"
            value={draft.category}
            onChange={(event) =>
              setDraft({ ...draft, category: event.target.value as ConfirmableConfig["category"] })
            }>
            <option value="general">General</option>
            <option value="technical">Technical</option>
            <option value="behavioral">Behavioral</option>
          </select>
        </label>
      </div>
      {error ? <p className="mt-3 text-sm text-red-400" role="alert">{error}</p> : null}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={pending || !draft.jobRole.trim()}
        className="mt-6 inline-flex h-11 items-center gap-2 rounded-full bg-emerald-400 px-6 text-sm font-semibold text-emerald-950 disabled:opacity-60">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
        Confirm and continue
      </button>
    </section>
  );
}
