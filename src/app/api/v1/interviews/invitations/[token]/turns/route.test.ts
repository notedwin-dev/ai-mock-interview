import { beforeEach, describe, expect, it, vi } from "vitest";
import { LlmError } from "@/lib/ai/llm";
import { RoomError } from "@/lib/interview/room";

const mocks = vi.hoisted(() => ({ runRoomTurn: vi.fn(), resolveInvitation: vi.fn() }));
vi.mock("@/lib/interview/room", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/interview/room")>();
  return { ...actual, runRoomTurn: mocks.runRoomTurn };
});
vi.mock("@/lib/interview/invitations", () => ({ resolveInvitation: mocks.resolveInvitation }));

import { GET, POST } from "./route";

const TOKEN = "t".repeat(43);
const ctx = { params: Promise.resolve({ token: TOKEN }) } as never;
function request(body: unknown) {
  return new Request("http://localhost/api/v1/interviews/invitations/tok/turns", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("token-scoped room turns API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("POST runs one turn through the room engine", async () => {
    const result = { messages: [], endCall: false, created: true };
    mocks.runRoomTurn.mockResolvedValue(result);
    const response = await POST(request({ contentText: "my answer", idempotencyKey: "turn-1" }), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(mocks.runRoomTurn).toHaveBeenCalledWith(TOKEN, { contentText: "my answer", idempotencyKey: "turn-1" });
  });

  it("GET refuses an invalid or revoked link", async () => {
    mocks.resolveInvitation.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/x"), ctx);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "invitation_not_found" } });
  });

  it("maps room, provider and validation failures to safe envelopes", async () => {
    mocks.runRoomTurn.mockRejectedValueOnce(new RoomError("invitation_not_found", "This interview link is not available."));
    const missing = await POST(request({ contentText: "hi" }), ctx);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "invitation_not_found" } });

    mocks.runRoomTurn.mockRejectedValueOnce(new RoomError("invalid_state", "This interview is not accepting turns."));
    const invalid = await POST(request({ contentText: "hi" }), ctx);
    expect(invalid.status).toBe(409);

    mocks.runRoomTurn.mockRejectedValueOnce(
      new LlmError("generation_failed", "provider refused sk-secret"),
    );
    const provider = await POST(request({ contentText: "hi" }), ctx);
    expect(provider.status).toBe(502);
    expect(JSON.stringify(await provider.json())).not.toContain("sk-secret");
  });
});
