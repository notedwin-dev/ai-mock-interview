import { describe, expect, it } from "vitest";
import {
  buildInstructions,
  closingLine,
  GENERATION_FIELDS,
  greeting,
  mapAnswersToConfig,
  TOOL_PARAMETERS,
} from "./generation-contract.mjs";

describe("voice generation contract", () => {
  it("uses the approved greeting verbatim", () => {
    expect(greeting("Adrian")).toBe(
      "Hello, Adrian! Let's prepare your interview. I'll ask you a few questions and generate a perfect interview just for you. Are you ready?",
    );
  });

  it("gives the model the complete ordered question list and forbids interviewing", () => {
    const instructions = buildInstructions("Adrian");
    GENERATION_FIELDS.forEach((field, index) => {
      expect(instructions).toContain(`${index + 1}. ${field.description}`);
    });
    expect(instructions).toContain("Ask the following five questions IN ORDER");
    expect(instructions).toContain("Wait for the candidate's answer before asking the next one");
    expect(instructions).toContain("You are NOT conducting the interview itself");
    expect(instructions).toContain("Never skip a question, never reorder them");
    expect(instructions).toContain("Never repeat the candidate's answer back to them");
  });

  it("exposes all five tool fields as required", () => {
    expect(TOOL_PARAMETERS.required).toEqual(GENERATION_FIELDS.map((field) => field.name));
  });

  it("maps the five submitted answers onto the approved agent config", () => {
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

  it("closes with the approved line", () => {
    expect(closingLine()).toBe("Your interview has been generated. Thank you for the call.");
  });
});
