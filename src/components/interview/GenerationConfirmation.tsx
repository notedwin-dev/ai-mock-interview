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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    try {
      await onConfirm(draft);
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
            value={(draft.techStack ?? []).join(", ")}
            onChange={(event) =>
              setDraft({
                ...draft,
                techStack: event.target.value.split(",").map((part) => part.trim()).filter(Boolean),
              })
            }
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-ink-muted">Questions</span>
          <input
            type="number"
            min={1}
            max={50}
            className="h-10 rounded-full border border-line bg-raised px-4 text-sm text-ink"
            value={draft.questionCount ?? ""}
            onChange={(event) =>
              setDraft({ ...draft, questionCount: Number(event.target.value) || undefined })
            }
          />
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
            <option value="general">Mixed (Technical + Behavioral)</option>
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
