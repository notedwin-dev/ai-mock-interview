import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderConfigError } from "@/lib/providers/config";

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
vi.mock("@/lib/interview/realtime-token", () => ({ createRealtimeToken: mocks.createRealtimeToken }));

import { POST } from "./route";

const TOKEN = "t".repeat(43);
const ctx = { params: Promise.resolve({ token: TOKEN }) } as never;

describe("POST .../realtime/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({ sessionId: "s1", userId: "owner-1", status: "scheduled" });
    mocks.resolveForOutboundCall.mockResolvedValue({
      providerName: "google", providerType: "preset", baseUrl: "https://generativelanguage.googleapis.com",
      modelId: "gemini-3.1-flash-live-preview", apiKey: "secret-key",
    });
    mocks.createRealtimeToken.mockResolvedValue({ token: "auth_secret", url: "wss://live.example" });
  });

  it("returns only ephemeral session data for a valid link", async () => {
    const response = await POST(new Request("http://localhost/x", { method: "POST" }), ctx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      token: "auth_secret", url: "wss://live.example", modelId: "gemini-3.1-flash-live-preview",
    });
    expect(JSON.stringify(body)).not.toContain("secret-key");
    expect(mocks.createRealtimeToken).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "gemini-3.1-flash-live-preview", apiKey: "secret-key" }),
    );
  });

  it("returns only the ElevenLabs client secret and WS URL for an elevenlabs route", async () => {
    mocks.resolveForOutboundCall.mockResolvedValueOnce({
      providerName: "elevenlabs", providerType: "preset", baseUrl: "https://api.elevenlabs.io",
      modelId: "eleven_realtime_v1_mini", apiKey: "sk_elevenlabs_secret_key",
    });
    mocks.createRealtimeToken.mockResolvedValueOnce({
      token: "el_client_secret",
      url: "wss://api.elevenlabs.io/v1/convai/realtime",
      expiresAt: 1_000_000_000,
    });

    const response = await POST(new Request("http://localhost/x", { method: "POST" }), ctx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      token: "el_client_secret",
      url: "wss://api.elevenlabs.io/v1/convai/realtime",
      modelId: "eleven_realtime_v1_mini",
    });
    // The stored provider key is write-only: it must never reach the client.
    expect(JSON.stringify(body)).not.toContain("sk_elevenlabs_secret_key");
    expect(mocks.createRealtimeToken).toHaveBeenCalledWith(
      expect.objectContaining({
        providerName: "elevenlabs",
        modelId: "eleven_realtime_v1_mini",
        apiKey: "sk_elevenlabs_secret_key",
      }),
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
});
