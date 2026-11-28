import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessToken } from "livekit-server-sdk";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(async () => ({ status: "scheduled" as string })),
  updateMany: vi.fn(async () => ({ count: 1 })),
}));

vi.mock("@/lib/db", () => ({
  db: { interviewSession: { findUnique: mocks.findUnique, updateMany: mocks.updateMany } },
}));

import { POST } from "./route";

const API_KEY = "lk-test-key";
const API_SECRET = "lk-test-secret-that-is-long-enough-for-hs256";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function signedBody(body: string, secret = API_SECRET): Promise<string> {
  const token = new AccessToken(API_KEY, secret);
  token.sha256 = createHash("sha256").update(body).digest("base64");
  return token.toJwt();
}

describe("POST /api/v1/webhooks/livekit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["LIVEKIT_URL"] = "wss://example.livekit.cloud";
    process.env["LIVEKIT_API_KEY"] = API_KEY;
    process.env["LIVEKIT_API_SECRET"] = API_SECRET;
    mocks.findUnique.mockResolvedValue({ status: "scheduled" });
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it("rejects a webhook without a signature", async () => {
    const response = await POST(
      new Request("http://localhost/api/v1/webhooks/livekit", {
        method: "POST",
        body: JSON.stringify({ event: "room_started", room: { name: SESSION_ID } }),
        headers: { "content-type": "application/webhook+json" },
      }),
    );
    expect(response.status).toBe(401);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a body that does not match the signed checksum", async () => {
    const original = JSON.stringify({ event: "room_started", room: { name: SESSION_ID } });
    const authorization = await signedBody(original);
    const tampered = JSON.stringify({ event: "room_finished", room: { name: SESSION_ID } });
    const response = await POST(
      new Request("http://localhost/api/v1/webhooks/livekit", {
        method: "POST",
        body: tampered,
        headers: { "content-type": "application/webhook+json", authorization },
      }),
    );
    expect(response.status).toBe(401);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("activates the session named by a verified room_started event", async () => {
    const body = JSON.stringify({ event: "room_started", room: { name: SESSION_ID } });
    const authorization = await signedBody(body);
    const response = await POST(
      new Request("http://localhost/api/v1/webhooks/livekit", {
        method: "POST",
        body,
        headers: { "content-type": "application/webhook+json", authorization },
      }),
    );
    expect(response.status).toBe(204);
    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId: SESSION_ID } }),
    );
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // Our atomic admission predicate also allows legacy `created` sessions
        // and never rewrites startedAt on a duplicate start.
        where: { sessionId: SESSION_ID, status: { in: ["scheduled", "created"] } },
        data: expect.objectContaining({ status: "active" }),
      }),
    );
  });

  it("completes an active session on room_finished", async () => {
    mocks.findUnique.mockResolvedValue({ status: "active" });
    const body = JSON.stringify({ event: "room_finished", room: { name: SESSION_ID } });
    const authorization = await signedBody(body);
    const response = await POST(
      new Request("http://localhost/api/v1/webhooks/livekit", {
        method: "POST",
        body,
        headers: { "content-type": "application/webhook+json", authorization },
      }),
    );
    expect(response.status).toBe(204);
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId: SESSION_ID, status: "active" },
        data: expect.objectContaining({ status: "completed" }),
      }),
    );
  });
});
