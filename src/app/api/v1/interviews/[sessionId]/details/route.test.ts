import { beforeEach, describe, expect, it, vi } from "vitest";
import { InterviewError } from "@/lib/interview/service";

const mocks = vi.hoisted(() => ({
  requireApiAccount: vi.fn(),
  editInterviewDetails: vi.fn(),
}));
vi.mock("@/lib/auth/guard", () => ({ requireApiAccount: mocks.requireApiAccount }));
vi.mock("@/lib/interview/scheduling", () => ({ editInterviewDetails: mocks.editInterviewDetails }));

import { PATCH } from "./route";

const USER_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const context = { params: Promise.resolve({ sessionId: SESSION_ID }) } as never;
const details = {
  jobRole: "Frontend Engineer",
  jobDescription: "",
  experienceLevel: "Senior",
  techStack: ["React"],
  questionCount: 8,
  evaluationMode: "balanced",
  category: "technical",
};
function request(body: unknown) {
  return new Request("http://localhost/api/v1/interviews/session/details", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/v1/interviews/[sessionId]/details", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAccount.mockResolvedValue({ account: { userId: USER_ID } });
  });

  it("requires the owning candidate", async () => {
    mocks.requireApiAccount.mockResolvedValue(null);
    const response = await PATCH(request(details), context);
    expect(response.status).toBe(401);
    expect(mocks.editInterviewDetails).not.toHaveBeenCalled();
  });

  it("edits the owner's details and maps invalid input", async () => {
    mocks.editInterviewDetails.mockResolvedValueOnce({ sessionId: SESSION_ID, ...details });
    const ok = await PATCH(request(details), context);
    expect(ok.status).toBe(200);
    expect(mocks.editInterviewDetails).toHaveBeenCalledWith(USER_ID, SESSION_ID, details);

    mocks.editInterviewDetails.mockRejectedValueOnce(
      new InterviewError("invalid_input", "Invalid details."),
    );
    const bad = await PATCH(request(details), context);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_input" } });
  });

  it("locks details after the interview has started", async () => {
    mocks.editInterviewDetails.mockRejectedValueOnce(
      new InterviewError("invalid_state", "Already started."),
    );
    const response = await PATCH(request(details), context);
    expect(response.status).toBe(409);
  });
});
