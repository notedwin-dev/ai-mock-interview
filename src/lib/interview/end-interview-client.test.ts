import { describe, expect, it, vi } from "vitest";
import { requestEndInterview } from "./end-interview-client";

/**
 * Hermetic tests for the invitation-room end action (FR-INTERVIEW-011). The
 * request contract is what the room button relies on, so it is tested without a
 * browser: a completed interview is idempotent, failures surface a message.
 */
const TOKEN = "t".repeat(43);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("requestEndInterview", () => {
  it("posts to the token-scoped end route and reports completion", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { status: "completed", completedAt: "2026-11-21T10:00:00.000Z", alreadyEnded: false }),
    ) as unknown as typeof fetch;

    const outcome = await requestEndInterview(TOKEN, fetchImpl);

    expect(outcome).toEqual({
      ok: true,
      alreadyEnded: false,
      completedAt: "2026-11-21T10:00:00.000Z",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/v1/interviews/invitations/${TOKEN}/end`,
      { method: "POST" },
    );
  });

  it("treats a repeat end request as success", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { status: "completed", completedAt: "2026-11-21T10:00:00.000Z", alreadyEnded: true }),
    ) as unknown as typeof fetch;

    const outcome = await requestEndInterview(TOKEN, fetchImpl);
    expect(outcome).toMatchObject({ ok: true, alreadyEnded: true });
  });

  it("surfaces the server message for an unusable link", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, { error: { message: "This interview link is not available." } }),
    ) as unknown as typeof fetch;

    expect(await requestEndInterview(TOKEN, fetchImpl)).toEqual({
      ok: false,
      message: "This interview link is not available.",
    });
  });

  it("falls back to a readable message when the response has no body", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect(await requestEndInterview(TOKEN, fetchImpl)).toEqual({
      ok: false,
      message: "The interview could not be ended.",
    });
  });

  it("reports an unreachable server instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    expect(await requestEndInterview(TOKEN, fetchImpl)).toEqual({
      ok: false,
      message: "Could not reach the server. Try again.",
    });
  });
});
