import { describe, expect, it } from "vitest";
import { InterviewError } from "./service";
import {
  assertEditableSession,
  editableDetailsSchema,
  parseScheduledAt,
} from "./scheduling";

describe("parseScheduledAt", () => {
  const now = new Date("2026-11-22T08:00:00.000Z");

  it("accepts a future ISO timestamp", () => {
    expect(parseScheduledAt("2026-11-23T09:30:00.000Z", now).toISOString()).toBe(
      "2026-11-23T09:30:00.000Z",
    );
  });

  it("rejects non-strings, malformed values, the past and far-future dates", () => {
    expect(() => parseScheduledAt(undefined, now)).toThrow(InterviewError);
    expect(() => parseScheduledAt("not-a-date", now)).toThrow(InterviewError);
    expect(() => parseScheduledAt("2026-11-21T09:00:00.000Z", now)).toThrow(InterviewError);
    expect(() => parseScheduledAt("2026-11-22T08:00:00.000Z", now)).toThrow(InterviewError);
    expect(() => parseScheduledAt("2028-11-22T08:00:00.000Z", now)).toThrow(InterviewError);
  });
});

describe("assertEditableSession", () => {
  it("allows setup and scheduled sessions that have not started", () => {
    expect(() =>
      assertEditableSession({ status: "scheduled", startedAt: null, completedAt: null }),
    ).not.toThrow();
    expect(() =>
      assertEditableSession({ status: "created", startedAt: null, completedAt: null }),
    ).not.toThrow();
  });

  it("locks details once started, completed or failed", () => {
    expect(() =>
      assertEditableSession({ status: "active", startedAt: null, completedAt: null }),
    ).toThrow(InterviewError);
    expect(() =>
      assertEditableSession({ status: "completed", startedAt: null, completedAt: null }),
    ).toThrow(InterviewError);
    expect(() =>
      assertEditableSession({ status: "failed", startedAt: null, completedAt: null }),
    ).toThrow(InterviewError);
    expect(() =>
      assertEditableSession({
        status: "scheduled",
        startedAt: new Date("2026-11-22T08:00:00.000Z"),
        completedAt: null,
      }),
    ).toThrow(InterviewError);
    expect(() =>
      assertEditableSession({
        status: "scheduled",
        startedAt: null,
        completedAt: new Date("2026-11-22T09:00:00.000Z"),
      }),
    ).toThrow(InterviewError);
  });
});

describe("editableDetailsSchema", () => {
  it("accepts the six generated detail values", () => {
    const parsed = editableDetailsSchema.parse({
      jobRole: "Frontend Engineer",
      jobDescription: "React role",
      experienceLevel: "Senior",
      techStack: ["React", "TypeScript"],
      questionCount: 8,
      evaluationMode: "balanced",
      category: "technical",
    });
    expect(parsed.jobRole).toBe("Frontend Engineer");
    expect(parsed.questionCount).toBe(8);
  });

  it("rejects an empty role, an unknown mode and extra keys", () => {
    const base = { evaluationMode: "balanced", category: "technical" };
    expect(() => editableDetailsSchema.parse({ ...base, jobRole: "" })).toThrow();
    expect(() => editableDetailsSchema.parse({ ...base, jobRole: "Role", evaluationMode: "x" })).toThrow();
    expect(() => editableDetailsSchema.parse({ ...base, jobRole: "Role", extra: true })).toThrow();
  });
});
