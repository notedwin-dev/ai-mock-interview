import { describe, expect, it } from "vitest";
import {
  buildInstructions,
  closingLine,
  greeting,
  mapAnswersToConfig,
} from "./generation-contract.mjs";

describe("voice generation contract", () => {
  it("uses the approved greeting verbatim", () => {
    expect(greeting("Adrian")).toBe(
      "Hello, Adrian! Let's prepare your interview. I'll ask you a few questions and generate a perfect interview just for you. Are you ready?",
    );
  });

  it("maps the five gathered answers onto the approved agent config", () => {
    expect(
      mapAnswersToConfig({
        role: "Frontend Engineer",
        type: "mixed",
        level: "Senior",
        techstack: "React, TypeScript",
        amount: "5",
      }),
    ).toEqual({
      purpose: "Prepare a mixed interview for Frontend Engineer.",
      jobRole: "Frontend Engineer",
      jobDescription: "Experience level: Senior. Tech stack: React, TypeScript. Number of questions: 5.",
      strictness: "balanced",
      category: "general",
    });
  });

  it("requires one question at a time and closes with the approved line", () => {
    const instructions = buildInstructions("Adrian");
    expect(instructions).toContain("wait for the candidate's answer before asking the next");
    expect(closingLine()).toBe("Your interview has been generated. Thank you for the call.");
  });
});
