import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { findActiveSessionByToken } from "./invitations";
import { classifyInterviewerUtterance } from "./realtime-transcript";
import type {
  RealtimeTranscriptMessage,
  RoomContext,
  RoomStore,
  TranscriptEntry,
} from "./room";

/**
 * Default persistence for the token-scoped room (FR-INTERVIEW-004). The token
 * is resolved to the owning session via its hash and grants access to that
 * interview's transcript only — never to the owner's account or other data.
 */

/** Fields every persisted transcript entry needs; keeps responses narrow. */
const MESSAGE_FIELDS = {
  sequenceNumber: true,
  speakerType: true,
  messageKind: true,
  contentText: true,
  assessmentUnitId: true,
} as const;

type MessageRow = {
  sequenceNumber: number;
  speakerType: string;
  messageKind: string;
  contentText: string;
  assessmentUnitId: string | null;
};

type Tx = Prisma.TransactionClient;

/** Bounded retries for a lost allocation race; a finalized line is never dropped. */
const ALLOCATION_ATTEMPTS = 3;

function toEntry(message: MessageRow): TranscriptEntry {
  return {
    sequenceNumber: message.sequenceNumber,
    speakerType: message.speakerType,
    messageKind: message.messageKind,
    contentText: message.contentText,
    assessmentUnitId: message.assessmentUnitId,
  };
}

/**
 * True when a P2002 came from the named unique constraint. Prisma reports the
 * violated columns/constraint in `meta`, so the fragment identifies which one.
 */
function isUniqueViolation(error: unknown, fragment: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  return JSON.stringify(error.meta ?? {}).includes(fragment);
}

/**
 * Runs a transcript write while holding a row lock on the interview session.
 *
 * `MAX(sequence_number) + 1` on its own races with a concurrent finalized audio
 * line: both requests read the same maximum, the later INSERT hits the unique
 * `(session_id, sequence_number)` constraint (P2002) and that line is lost.
 * Serializing per session on the parent row makes the read-then-insert atomic
 * and also protects assessment-unit numbering (`(session_id, unit_number)`).
 */
async function withSessionLock<T>(sessionId: string, run: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT session_id FROM interview_session WHERE session_id = ${sessionId}::uuid FOR UPDATE`;
    return run(tx);
  });
}

/** Appends one message at the next position inside the locked transaction. */
async function insertMessage(
  tx: Tx,
  sessionId: string,
  data: {
    speakerType: "candidate" | "interviewer";
    messageKind: string;
    contentText: string;
    idempotencyKey?: string | null;
    assessmentUnitId: string | null;
  },
): Promise<MessageRow> {
  const aggregate = await tx.conversationMessage.aggregate({
    where: { sessionId },
    _max: { sequenceNumber: true },
  });
  return tx.conversationMessage.create({
    data: {
      sessionId,
      sequenceNumber: (aggregate._max.sequenceNumber ?? 0) + 1,
      ...data,
    },
    select: MESSAGE_FIELDS,
  });
}

async function allocate<T>(
  sessionId: string,
  fragment: string,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withSessionLock(sessionId, run);
    } catch (error) {
      if (attempt < ALLOCATION_ATTEMPTS && isUniqueViolation(error, fragment)) continue;
      throw error;
    }
  }
}

async function activeUnitId(tx: Tx, sessionId: string): Promise<string | null> {
  const unit = await tx.interviewAssessmentUnit.findFirst({
    where: { sessionId, status: "open" },
    orderBy: { unitNumber: "desc" },
    select: { assessmentUnitId: true },
  });
  return unit?.assessmentUnitId ?? null;
}

/**
 * Closes every open unit and opens the next numbered one in the same
 * transaction (FR-TRANSCRIPT-004: a new primary question opens a new unit).
 */
async function openNextUnit(tx: Tx, sessionId: string): Promise<string> {
  await tx.interviewAssessmentUnit.updateMany({
    where: { sessionId, status: "open" },
    data: { status: "closed", closedAt: new Date() },
  });
  const aggregate = await tx.interviewAssessmentUnit.aggregate({
    where: { sessionId },
    _max: { unitNumber: true },
  });
  const unit = await tx.interviewAssessmentUnit.create({
    data: { sessionId, unitNumber: (aggregate._max.unitNumber ?? 0) + 1 },
    select: { assessmentUnitId: true },
  });
  return unit.assessmentUnitId;
}

export function createDefaultRoomStore(): RoomStore {
  return {
    async context(token): Promise<RoomContext | null> {
      const session = await findActiveSessionByToken(token);
      if (!session) return null;
      return {
        ...session,
        techStack: Array.isArray(session.techStack)
          ? session.techStack.filter((value): value is string => typeof value === "string")
          : [],
      };
    },

    async messages(sessionId) {
      const rows = await db.conversationMessage.findMany({
        where: { sessionId },
        orderBy: { sequenceNumber: "asc" },
        select: MESSAGE_FIELDS,
      });
      return rows.map(toEntry);
    },

    async activate(sessionId) {
      // Conditional write: a duplicate/out-of-order webhook delivery must not
      // rewrite startedAt of a session that has already moved on.
      await db.interviewSession.updateMany({
        where: { sessionId, status: "scheduled" },
        data: { status: "active", startedAt: new Date() },
      });
    },

    async appendCandidate(sessionId, contentText, idempotencyKey, assessmentUnitId) {
      const row = await allocate(sessionId, "sequence_number", async (tx) => {
        if (idempotencyKey) {
          const existing = await tx.conversationMessage.findFirst({
            where: { sessionId, idempotencyKey },
            select: MESSAGE_FIELDS,
          });
          if (existing) return { existing, created: false as const };
        }
        const created = await insertMessage(tx, sessionId, {
          speakerType: "candidate",
          messageKind: "candidate_response",
          contentText,
          idempotencyKey: idempotencyKey ?? null,
          assessmentUnitId,
        });
        return { existing: created, created: true as const };
      });
      return { entry: toEntry(row.existing), created: row.created };
    },

    async appendInterviewer(sessionId, contentText, messageKind, assessmentUnitId) {
      const row = await allocate(sessionId, "sequence_number", (tx) =>
        insertMessage(tx, sessionId, {
          speakerType: "interviewer",
          messageKind,
          contentText,
          assessmentUnitId,
        }),
      );
      return toEntry(row);
    },

    async appendInterviewerWithNewUnit(sessionId, contentText) {
      const row = await allocate(sessionId, "sequence_number", async (tx) => {
        const unitId = await openNextUnit(tx, sessionId);
        return insertMessage(tx, sessionId, {
          speakerType: "interviewer",
          messageKind: "primary_question",
          contentText,
          assessmentUnitId: unitId,
        });
      });
      return toEntry(row);
    },

    async activeUnit(sessionId) {
      const unit = await db.interviewAssessmentUnit.findFirst({
        where: { sessionId, status: "open" },
        orderBy: { unitNumber: "desc" },
        select: { assessmentUnitId: true },
      });
      return unit?.assessmentUnitId ?? null;
    },

    async openUnit(sessionId) {
      return allocate(sessionId, "unit_number", (tx) => openNextUnit(tx, sessionId));
    },

    async complete(sessionId) {
      // Conditional write: a repeated room_finished (or a late delivery after
      // the candidate already ended) never rewrites completedAt.
      await db.interviewSession.updateMany({
        where: { sessionId, status: "active" },
        data: { status: "completed", completedAt: new Date() },
      });
    },

    /**
     * One finalized native-realtime line (FR-TRANSCRIPT-001/002/004). The audio
     * path stores exactly the same structure as the typed path: a question opens
     * or joins an assessment unit, a conversational acknowledgement stays in the
     * transcript without one, and a candidate line joins the active unit.
     */
    async appendRealtimeMessage(sessionId, message: RealtimeTranscriptMessage) {
      const row = await allocate(sessionId, "sequence_number", async (tx) => {
        const existing = await tx.conversationMessage.findFirst({
          where: { sessionId, idempotencyKey: message.clientId },
          select: MESSAGE_FIELDS,
        });
        if (existing) return existing;

        if (message.speaker === "candidate") {
          return insertMessage(tx, sessionId, {
            speakerType: "candidate",
            messageKind: "candidate_response",
            contentText: message.contentText,
            idempotencyKey: message.clientId,
            assessmentUnitId: await activeUnitId(tx, sessionId),
          });
        }

        const openUnit = await activeUnitId(tx, sessionId);
        const classified = classifyInterviewerUtterance(message.contentText);
        // A follow-up needs an active unit to attach to. Without one the
        // question opens a unit, so every question stays assessable.
        const kind =
          classified === "follow_up_question" && !openUnit ? "primary_question" : classified;
        const assessmentUnitId =
          kind === "primary_question"
            ? await openNextUnit(tx, sessionId)
            : kind === "follow_up_question"
              ? openUnit
              : null;
        return insertMessage(tx, sessionId, {
          speakerType: "interviewer",
          messageKind: kind,
          contentText: message.contentText,
          idempotencyKey: message.clientId,
          assessmentUnitId,
        });
      });
      return toEntry(row);
    },
  };
}
