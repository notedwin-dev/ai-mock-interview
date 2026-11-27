import { beforeEach, describe, expect, it, vi } from "vitest";
import { AsrError } from "@/lib/ai/asr";
import { ProviderConfigError } from "@/lib/providers/config";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  resolveForOutboundCall: vi.fn(),
  transcribeAudio: vi.fn(),
}));
vi.mock("@/lib/interview/room-store", () => ({
  createDefaultRoomStore: () => ({ context: mocks.context }),
}));
vi.mock("@/lib/providers/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/config")>();
  return { ...actual, resolveForOutboundCall: mocks.resolveForOutboundCall };
});
vi.mock("@/lib/ai/asr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/asr")>();
  return { ...actual, transcribeAudio: mocks.transcribeAudio };
});

import { POST } from "./route";

const TOKEN = "t".repeat(43);
const ctx = { params: Promise.resolve({ token: TOKEN }) } as never;
function request(body: unknown) {
  return new Request("http://localhost/api/v1/interviews/invitations/tok/transcribe", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
const validBody = { audioBase64: "AQID", mimeType: "audio/webm" };

describe("POST /api/v1/interviews/invitations/[token]/transcribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({ sessionId: "s1", userId: "owner-1", status: "active" });
    mocks.resolveForOutboundCall.mockResolvedValue({
      providerName: "google", providerType: "preset", baseUrl: "https://generativelanguage.googleapis.com",
      modelId: "gemini-3.5-transcribe", apiKey: "k",
    });
    mocks.transcribeAudio.mockResolvedValue("I fixed a slow query.");
  });

  it("transcribes audio for that interview only and returns reviewable text", async () => {
    const response = await POST(request(validBody), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "I fixed a slow query." });
    expect(mocks.transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "gemini-3.5-transcribe" }),
      new Uint8Array([1, 2, 3]),
      "audio/webm",
    );
  });

  it("refuses invalid links and validates the audio payload", async () => {
    mocks.context.mockResolvedValueOnce(null);
    const missing = await POST(request(validBody), ctx);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "invitation_not_found" } });

    const bad = await POST(request({ audioBase64: "", mimeType: "video/mp4" }), ctx);
    expect(bad.status).toBe(400);
    expect(mocks.transcribeAudio).not.toHaveBeenCalled();
  });

  it("reports missing ASR config and provider failures without leaking keys", async () => {
    mocks.resolveForOutboundCall.mockRejectedValueOnce(new ProviderConfigError("not_found", "No enabled provider serves asr."));
    const unconfigured = await POST(request(validBody), ctx);
    expect(unconfigured.status).toBe(409);
    expect(await unconfigured.json()).toMatchObject({ error: { code: "voice_not_configured" } });

    mocks.transcribeAudio.mockRejectedValueOnce(new AsrError("unsupported_provider", "only Google secret-key"));
    const unsupported = await POST(request(validBody), ctx);
    expect(unsupported.status).toBe(409);
    const unsupportedBody = await unsupported.json();
    expect(unsupportedBody).toMatchObject({ error: { code: "asr_provider_unsupported" } });

    mocks.transcribeAudio.mockRejectedValueOnce(new AsrError("generation_failed", "provider rejected secret-key"));
    const failed = await POST(request(validBody), ctx);
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await failed.json())).not.toContain("secret-key");
  });
});
