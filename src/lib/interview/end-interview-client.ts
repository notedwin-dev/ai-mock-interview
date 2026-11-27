/**
 * End-interview request from an invitation link (FR-INTERVIEW-011).
 *
 * The invitation room is token-scoped: the visitor holds a capability link, not
 * an account session, so the authenticated `/api/v1/interviews/[sessionId]/end`
 * route is not usable here. This helper is kept out of the components so the
 * request/idempotency contract is testable without a browser.
 */
export interface EndInterviewSuccess {
  ok: true;
  /** True when the interview had already been completed (repeat request). */
  alreadyEnded: boolean;
  completedAt: string | null;
}

export interface EndInterviewFailure {
  ok: false;
  message: string;
}

export type EndInterviewOutcome = EndInterviewSuccess | EndInterviewFailure;

export async function requestEndInterview(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EndInterviewOutcome> {
  try {
    const response = await fetchImpl(
      `/api/v1/interviews/invitations/${encodeURIComponent(token)}/end`,
      { method: "POST" },
    );
    const body = (await response.json().catch(() => null)) as
      | { completedAt?: string | null; alreadyEnded?: boolean; error?: { message?: string } }
      | null;
    if (!response.ok) {
      return { ok: false, message: body?.error?.message ?? "The interview could not be ended." };
    }
    return {
      ok: true,
      alreadyEnded: body?.alreadyEnded === true,
      completedAt: body?.completedAt ?? null,
    };
  } catch {
    return { ok: false, message: "Could not reach the server. Try again." };
  }
}
