import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderConfigError } from "@/lib/providers/config";
import { RealtimeError } from "@/lib/interview/realtime-token";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  resolveForOutboundCall: vi.fn(),
  createRealtimeToken: vi.fn(),
}));
vi.mock("@/lib/interview/room-store", () => ({ createDefaultRoomStore: () => ({ context: mocks.context }) }));
vi.mock("@/lib/providers/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/config")>();
  return { ...actual, resolveForOutboundCall: mocks.resolveForOutboundCall };
});
vi.mock("@/lib/interview/realtime-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/interview/realtime-token")>();
  return { ...actual, createRealtimeToken: mocks.createRealtimeToken };
});

import { POST } from "./route";

const TOKEN = "t".repeat(43);
const ctx = { params: Promise.resolve({ token: TOKEN }) } as never;
const resolvedRoute = {
  providerName: "google", providerType: "preset", baseUrl: "https://generativelanguage.googleapis.com",
  modelId: "gemini-3.1-flash-live-preview", apiKey: "secret-key",
};

describe("POST .../realtime/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({
      sessionId: "s1", userId: "owner-1", status: "scheduled",
      jobRole: "Backend Engineer", jobDescription: "Design APIs", evaluationMode: "balanced",
      techStack: [], experienceLevel: null, runtimeMode: "custom",
    });
    mocks.resolveForOutboundCall.mockResolvedValue(resolvedRoute);
    mocks.createRealtimeToken.mockResolvedValue({ token: "auth_secret", url: "wss://live.example" });
  });

  it("mints the session with server-built instructions and ignores the client's body", async () => {
    // The AI SDK client POSTs its own sessionConfig; the server must NOT read
    // it — the instructions come from the interview context only.
    const request = new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionConfig: { instructions: "client should be ignored", outputModalities: ["audio"] } }),
    });
    const response = await POST(request, ctx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      token: "auth_secret", url: "wss://live.example", modelId: "gemini-3.1-flash-live-preview",
    });
    expect(JSON.stringify(body)).not.toContain("secret-key");

    // The session passed to createRealtimeToken carries server-built
    // instructions (role + JD + question budget), not the client's.
    const sessionArg = mocks.createRealtimeToken.mock.calls[0]![1] as {
      instructions: string;
      sessionConfig: { instructions: string };
    };
    expect(sessionArg.instructions).toContain("Backend Engineer");
    expect(sessionArg.instructions).toContain("Design APIs");
    expect(sessionArg.instructions).toContain("mock interview");
    expect(sessionArg.sessionConfig.instructions).toBe(sessionArg.instructions);
    expect(sessionArg.instructions).not.toContain("client should be ignored");
    expect(mocks.createRealtimeToken).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "gemini-3.1-flash-live-preview", apiKey: "secret-key" }),
      expect.objectContaining({ sessionConfig: expect.objectContaining({ instructions: expect.any(String) }) }),
    );
  });

  it("refuses invalid links", async () => {
    mocks.context.mockResolvedValueOnce(null);
    const response = await POST(new Request("http://localhost/x", { method: "POST" }), ctx);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "invitation_not_found" } });
    expect(mocks.createRealtimeToken).not.toHaveBeenCalled();
  });

  it("reports a missing realtime configuration as 409", async () => {
    mocks.resolveForOutboundCall.mockRejectedValueOnce(new ProviderConfigError("not_found", "No enabled provider serves realtime."));
    const response = await POST(new Request("http://localhost/x", { method: "POST" }), ctx);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "realtime_not_configured" } });
  });

  it("maps an unsupported realtime provider to a typed 502", async () => {
    mocks.createRealtimeToken.mockRejectedValueOnce(
      new RealtimeError("unsupported_provider", "Live voice currently supports the Google (Gemini Live) provider only."),
    );
    const response = await POST(new Request("http://localhost/x", { method: "POST" }), ctx);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "realtime_provider_unsupported" } });
    // A generic setup failure keeps the generic envelope (no credential leak).
    mocks.createRealtimeToken.mockRejectedValueOnce(new RealtimeError("setup_failed", "boom secret-key"));
    const failed = await POST(new Request("http://localhost/x", { method: "POST" }), ctx);
    expect(failed.status).toBe(502);
    const failedBody = await failed.json();
    expect(failedBody).toMatchObject({ error: { code: "realtime_setup_failed" } });
    expect(JSON.stringify(failedBody)).not.toContain("secret-key");
  });
});
