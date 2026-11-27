import { beforeAll, describe, expect, it, vi } from "vitest";

/** Hermetic tests for the LiveKit agent's pure helpers (no worker connection). */
type Helpers = {
  buildInstructions: (meta: { jobRole?: string; jobDescription?: string | null }) => string;
  itemText: (content: unknown) => string;
  roleForMetadata: (meta: unknown) => string;
};
let helpers: Helpers;
beforeAll(async () => {
  vi.stubEnv("AIMIS_AGENT_DISABLE_CLI", "1");
  // Importing the LiveKit SDK is heavy under parallel test workers; give it a
  // bounded but realistic budget instead of the default 10s hook timeout.
  helpers = (await import("../../../scripts/livekit-agent.mjs")) as unknown as Helpers;
}, 30000);

describe("single LiveKit agent routing", () => {
  it("routes generator and interviewer dispatches by metadata role", () => {
    expect(helpers.roleForMetadata({ role: "generator" })).toBe("generator");
    expect(helpers.roleForMetadata({ role: "interviewer" })).toBe("interviewer");
    expect(helpers.roleForMetadata({})).toBe("interviewer");
    expect(helpers.roleForMetadata(null)).toBe("interviewer");
  });
});

describe("LiveKit interviewer agent", () => {
  it("uses the interview context in instructions and forbids invented facts", () => {
    const instructions = helpers.buildInstructions({
      jobRole: "Backend Engineer",
      jobDescription: "Design APIs",
    });
    expect(instructions).toContain("Backend Engineer");
    expect(instructions).toContain("Design APIs");
    expect(instructions).toMatch(/never invent/i);
  });

  it("extracts plain text from chat content parts", () => {
    expect(helpers.itemText([{ type: "text", text: "Tell me more." }])).toBe("Tell me more.");
    expect(helpers.itemText("Hello")).toBe("Hello");
    expect(helpers.itemText([])).toBe("");
  });
});

