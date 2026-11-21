"use client";

import { useState } from "react";
import { Loader2, PhoneOff } from "lucide-react";
import { requestEndInterview, type EndInterviewSuccess } from "@/lib/interview/end-interview-client";

/**
 * Confirm-then-End control for the invitation room (FR-INTERVIEW-011).
 * Ending is explicit and confirmed; the token-scoped route is idempotent, so a
 * double click or a retry after a dropped response never creates a second
 * completion event.
 */
export function EndInterviewButton({
  token,
  onEnded,
  label = "End interview",
}: {
  token: string;
  onEnded: (result: EndInterviewSuccess) => void;
  label?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function end() {
    if (!window.confirm("End this interview? Your transcript is saved and stays available.")) {
      return;
    }
    setPending(true);
    setError(null);
    const outcome = await requestEndInterview(token);
    setPending(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    onEnded(outcome);
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={() => void end()}
        disabled={pending}
        className="inline-flex h-11 items-center gap-2 rounded-full bg-red-500 px-6 text-sm font-semibold text-white outline-none transition-all hover:bg-red-400 focus-visible:ring-2 focus-visible:ring-red-400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <PhoneOff className="h-4 w-4" aria-hidden />}
        {pending ? "Ending…" : label}
      </button>
      {error ? <p className="text-xs text-red-400" role="alert">{error}</p> : null}
    </div>
  );
}
