import { describe, expect, it } from "vitest";
import {
  classifyInterviewerUtterance,
  isQuestionUtterance,
} from "./realtime-transcript";

/**
 * Hermetic tests for native-realtime message-kind classification
 * (FR-TRANSCRIPT-001/004). The native audio path has no structural label, so
 * this pure function is the only place a question, a follow-up and a
 * conversational acknowledgement are told apart.
 */
describe("classifyInterviewerUtterance", () => {
  it("treats a greeting or a bare acknowledgement as a non-assessable utterance", () => {
    expect(classifyInterviewerUtterance("Hello and welcome to your mock interview.")).toBe("acknowledgement");
    expect(classifyInterviewerUtterance("Thanks, that is really helpful.")).toBe("acknowledgement");
    expect(classifyInterviewerUtterance("Great answer. Now let us move on to system design.")).toBe("acknowledgement");
    expect(classifyInterviewerUtterance("   ")).toBe("acknowledgement");
  });

  it("opens a new assessment area for a question without a back-reference", () => {
    expect(classifyInterviewerUtterance("Tell me about a project you are proud of.")).toBe("primary_question");
    expect(classifyInterviewerUtterance("What is your experience with PostgreSQL?")).toBe("primary_question");
    expect(classifyInterviewerUtterance("Okay, so walk me through your last role.")).toBe("primary_question");
    expect(classifyInterviewerUtterance("Describe a time you disagreed with a teammate.")).toBe("primary_question");
  });

  it("recognises an explicit back-reference as a follow-up", () => {
    expect(
      classifyInterviewerUtterance("You mentioned Kafka — how did you handle ordering?"),
    ).toBe("follow_up_question");
    expect(
      classifyInterviewerUtterance("Great answer. Can you elaborate on the testing strategy?"),
    ).toBe("follow_up_question");
    expect(classifyInterviewerUtterance("Can you give me an example?")).toBe("follow_up_question");
    expect(classifyInterviewerUtterance("What did you mean by your answer earlier?")).toBe("follow_up_question");
  });

  it("never reports an acknowledgement as a question", () => {
    const utterances = [
      "Nice.",
      "Okay.",
      "I see, thank you.",
      "Right, let us continue.",
      "Perfect, that covers it.",
    ];
    for (const utterance of utterances) {
      expect(isQuestionUtterance(utterance)).toBe(false);
      expect(classifyInterviewerUtterance(utterance)).toBe("acknowledgement");
    }
  });

  it("normalises whitespace before classifying", () => {
    expect(classifyInterviewerUtterance("  What   did you\nbuild?  ")).toBe("primary_question");
  });
});
