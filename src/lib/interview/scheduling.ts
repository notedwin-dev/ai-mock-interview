import { z } from "zod";
import { db } from "@/lib/db";
import { InterviewError, loadOwnedSession } from "./service";

/**
 * User-owned interview scheduling (owner decision 2026-11-22).
 *
 * The voice generator only produces interview details. The candidate then
 * chooses to start now, schedule for later, or leave and set it later.
 * `scheduledAt` is informational: it is shown on the dashboard and never gates
 * joining, which still requires the candidate to enter the waiting room and
 * click join. Details stay editable until the interview starts or completes.
 */

export const EDITABLE_STATUSES = ["created", "scheduled"] as const;

export const editableDetailsSchema = z
  .object({
    jobRole: z.string().trim().min(1).max(150),
    jobDescription: z.string().trim().max(8000).default(""),
    experienceLevel: z.string().trim().max(120).optional(),
    techStack: z.array(z.string().trim().min(1).max(80)).max(40).optional(),
    questionCount: z.number().int().min(1).max(50).optional(),
    evaluationMode: z.enum(["supportive", "balanced", "rigorous"]),
    category: z.enum(["general", "technical", "behavioral"]),
  })
  .strict();

export type EditableDetails = z.infer<typeof editableDetailsSchema>;

export interface ScheduledInterview {
  sessionId: string;
  scheduledAt: string | null;
  status: string;
}

/** Pure validation so the rule is testable without a database. */
export function parseScheduledAt(value: unknown, now = new Date()): Date {
  if (typeof value !== "string") {
    throw new InterviewError("invalid_input", "A valid date and time is required.");
  }
  // An offset-less timestamp is interpreted in the server's local timezone, so
  // the same request would store different instants on different hosts.
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) {
    throw new InterviewError("invalid_input", "Include a UTC offset or Z in the date and time.");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InterviewError("invalid_input", "A valid date and time is required.");
  }
  if (date.getTime() <= now.getTime()) {
    throw new InterviewError("invalid_input", "Choose a date and time in the future.");
  }
  const oneYear = 365 * 24 * 60 * 60 * 1000;
  if (date.getTime() > now.getTime() + oneYear) {
    throw new InterviewError("invalid_input", "Choose a date and time within the next year.");
  }
  return date;
}

/**
 * Pure lock rule, shared by the server boundary and the edit page (TT-8 review
 * dedup): a session's details are locked once it has started or completed, or
 * when its status is outside the editable set.
 */
export function isEditableSession(session: {
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
}): boolean {
  return (
    !session.startedAt &&
    !session.completedAt &&
    (EDITABLE_STATUSES as readonly string[]).includes(session.status)
  );
}

/** Details lock as soon as a session has started, completed or failed. */
export function assertEditableSession(session: {
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
}): void {
  if (!isEditableSession(session)) {
    throw new InterviewError(
      "invalid_state",
      "This interview has already started or completed, so its details are locked.",
    );
  }
}

/** Re-check the editability lock at write time (a start may commit after the pre-check). */
function editableWriteWhere(sessionId: string) {
  return {
    sessionId,
    status: { in: [...EDITABLE_STATUSES] },
    startedAt: null,
    completedAt: null,
  };
}

function assertEditableWrite(count: number): void {
  if (count === 0) {
    throw new InterviewError(
      "invalid_state",
      "This interview has already started or completed, so its details are locked.",
    );
  }
}

export async function scheduleInterview(
  userId: string,
  sessionId: string,
  input: unknown,
): Promise<ScheduledInterview> {
  const session = await loadOwnedSession(userId, sessionId);
  assertEditableSession(session);
  const scheduledAt = parseScheduledAt(
    typeof input === "object" && input !== null && "scheduledAt" in input
      ? (input as { scheduledAt: unknown }).scheduledAt
      : undefined,
  );
  const updated = await db.interviewSession.updateMany({
    where: editableWriteWhere(session.sessionId),
    data: { scheduledAt },
  });
  assertEditableWrite(updated.count);
  return {
    sessionId: session.sessionId,
    scheduledAt: scheduledAt.toISOString(),
    status: session.status,
  };
}

export async function clearSchedule(userId: string, sessionId: string): Promise<ScheduledInterview> {
  const session = await loadOwnedSession(userId, sessionId);
  assertEditableSession(session);
  const updated = await db.interviewSession.updateMany({
    where: editableWriteWhere(session.sessionId),
    data: { scheduledAt: null },
  });
  assertEditableWrite(updated.count);
  return {
    sessionId: session.sessionId,
    scheduledAt: null,
    status: session.status,
  };
}

export async function editInterviewDetails(
  userId: string,
  sessionId: string,
  input: unknown,
): Promise<{ sessionId: string } & EditableDetails> {
  const session = await loadOwnedSession(userId, sessionId);
  assertEditableSession(session);
  const details = editableDetailsSchema.parse(input);
  const category = await db.interviewCategory.findFirst({
    where: { categoryCode: details.category, isActive: true },
    select: { categoryId: true, categoryName: true },
  });
  if (!category) {
    throw new InterviewError("invalid_input", "The selected interview category is not available.");
  }
  const updated = await db.interviewSession.updateMany({
    where: editableWriteWhere(session.sessionId),
    data: {
      jobRole: details.jobRole,
      jobDescription: details.jobDescription || null,
      experienceLevel: details.experienceLevel ?? null,
      techStack: details.techStack ? (details.techStack as unknown as never) : undefined,
      questionCount: details.questionCount ?? null,
      evaluationMode: details.evaluationMode,
      categoryId: category.categoryId,
      categoryCodeSnapshot: details.category,
      categoryNameSnapshot: category.categoryName,
    },
  });
  assertEditableWrite(updated.count);
  return { sessionId: session.sessionId, ...details };
}
