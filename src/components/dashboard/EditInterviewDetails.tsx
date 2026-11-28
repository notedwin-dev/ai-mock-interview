"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  GenerationConfirmation,
  type ConfirmableConfig,
} from "@/components/interview/GenerationConfirmation";

/** Reuses the generation review form for editing an unscheduled interview. */
export function EditInterviewDetails({
  sessionId,
  config,
}: {
  sessionId: string;
  config: ConfirmableConfig;
}) {
  const router = useRouter();

  async function save(draft: ConfirmableConfig) {
    const response = await fetch(`/api/v1/interviews/${encodeURIComponent(sessionId)}/details`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobRole: draft.jobRole,
        jobDescription: draft.jobDescription,
        experienceLevel: draft.experienceLevel,
        techStack: draft.techStack,
        questionCount: draft.questionCount,
        evaluationMode: draft.strictness,
        category: draft.category,
      }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      throw new Error(body?.error?.message ?? "Could not save the changes.");
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/dashboard" className="text-sm text-ink-muted underline underline-offset-4">
        Back to dashboard
      </Link>
      <GenerationConfirmation
        config={config}
        onConfirm={save}
      />
    </div>
  );
}
