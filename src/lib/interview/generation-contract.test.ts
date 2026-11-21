import { describe, expect, it } from "vitest";
import {
  beginGathering,
  buildInstructions,
  closingLine,
  createPlanningState,
  GENERATION_FIELDS,
  greeting,
  mapAnswersToConfig,
  recordAnswer,
} from "./generation-contract.mjs";

describe("voice generation contract", () => {
  it("uses the approved greeting verbatim", () => {
    expect(greeting("Adrian")).toBe(
      "Hello, Adrian! Let's prepare your interview. I'll ask you a few questions and generate a perfect interview just for you. Are you ready?",
    );
  });

  it("asks one question at a time, in the approved order, then finishes", () => {
    const state = createPlanningState();
    expect(recordAnswer(state, "too early")).toBeNull();
    expect(beginGathering(state)).toBe(GENERATION_FIELDS[0]!.description);

    const answers = [
      "Frontend Engineer",
      "technical",
      "Mid level",
      "React, TypeScript",
      "5",
    ];
    const fieldNames = GENERATION_FIELDS.map((field) => field.name);
    answers.forEach((answer, index) => {
      const step = recordAnswer(state, answer);
      if (index < answers.length - 1) {
        expect(step).toEqual({ done: false, question: GENERATION_FIELDS[index + 1]!.description });
      } else {
        expect(step).toEqual({ done: true, answers: Object.fromEntries(fieldNames.map((name, i) => [name, answers[i]])) });
      }
    });
    expect(state.done).toBe(true);
    expect(recordAnswer(state, "ignored")).toBeNull();
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

  it("keeps the model from inventing extra turns and closes with the approved line", () => {
    expect(buildInstructions("Adrian")).toContain("Never invent additional questions or skip ahead");
    expect(closingLine()).toBe("Your interview has been generated. Thank you for the call.");
  });
});
