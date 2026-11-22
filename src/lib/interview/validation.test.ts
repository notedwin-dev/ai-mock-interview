import { describe, expect, it } from "vitest";
import { interviewSetupSchema, typedTurnSchema } from "./validation";

describe("interviewSetupSchema (FR-SETUP-001..005)", () => {
  const base = {
    jobRole: "Backend Engineer",
    jobDescription: "Build REST APIs with TypeScript.",
    categoryId: "11111111-1111-4111-8111-111111111111",
    evaluationMode: "balanced",
    runtimeMode: "custom",
  };

  it("accepts the approved setup shape and trims text fields", () => {
    const parsed = interviewSetupSchema.parse({ ...base, jobRole: "  Backend Engineer  " });
    expect(parsed.jobRole).toBe("Backend Engineer");
  });

  it("keeps the job description optional (FR-SETUP-002: enter OR paste)", () => {
    const { jobDescription: _omitted, ...withoutDescription } = base;
    expect(interviewSetupSchema.parse(withoutDescription).jobDescription).toBeUndefined();
  });

  it("rejects unknown evaluation/runtime modes (DB CHECK domains)", () => {
    expect(() => interviewSetupSchema.parse({ ...base, evaluationMode: "brutal" })).toThrow();
    expect(() => interviewSetupSchema.parse({ ...base, runtimeMode: "native_voice" })).toThrow();
  });

  it("rejects a role beyond VARCHAR(150) and a malformed category id", () => {
    expect(() => interviewSetupSchema.parse({ ...base, jobRole: "r".repeat(151) })).toThrow();
    expect(() => interviewSetupSchema.parse({ ...base, categoryId: "not-a-uuid" })).toThrow();
  });

  it("rejects unknown fields (strict contract)", () => {
    expect(() => interviewSetupSchema.parse({ ...base, difficulty: "hard" })).toThrow();
  });
});

describe("typedTurnSchema (FR-INTERVIEW-004, NFR-REL-002)", () => {
  it("accepts a text response with an optional idempotency key", () => {
    const parsed = typedTurnSchema.parse({
      contentText: "I would start by profiling the query.",
      inputMode: "text",
      idempotencyKey: "turn-1",
    });
    expect(parsed.inputMode).toBe("text");
  });

  it("rejects empty and oversized responses", () => {
    expect(() => typedTurnSchema.parse({ contentText: "   ", inputMode: "text" })).toThrow();
    expect(() =>
      typedTurnSchema.parse({ contentText: "x".repeat(5001), inputMode: "text" }),
    ).toThrow();
  });

  it("rejects voice input in the typed slice (M2 wires the voice loop)", () => {
    expect(() => typedTurnSchema.parse({ contentText: "hi", inputMode: "voice" })).toThrow();
  });

  it("rejects malformed idempotency keys", () => {
    expect(() =>
      typedTurnSchema.parse({ contentText: "hi", inputMode: "text", idempotencyKey: "bad key!" }),
    ).toThrow();
    expect(() =>
      typedTurnSchema.parse({ contentText: "hi", inputMode: "text", idempotencyKey: "k".repeat(101) }),
    ).toThrow();
  });
});
