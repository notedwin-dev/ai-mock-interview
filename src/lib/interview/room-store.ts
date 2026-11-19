import { db } from "@/lib/db";
import { hashInvitationToken } from "./invitation-token";
import type { RoomContext, RoomStore, TranscriptEntry } from "./room";

/**
 * Default persistence for the token-scoped room (FR-INTERVIEW-004). The token
 * is resolved to the owning session via its hash and grants access to that
 * interview's transcript only — never to the owner's account or other data.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function toEntry(message: {
  sequenceNumber: number;
  speakerType: string;
  messageKind: string;
  contentText: string;
  assessmentUnitId: string | null;
}): TranscriptEntry {
  return {
    sequenceNumber: message.sequenceNumber,
    speakerType: message.speakerType,
    messageKind: message.messageKind,
    contentText: message.contentText,
    assessmentUnitId: message.assessmentUnitId,
  };
}

async function nextSequence(sessionId: string): Promise<number> {
  const aggregate = await db.conversationMessage.aggregate({
    where: { sessionId },
    _max: { sequenceNumber: true },
  });
  return (aggregate._max.sequenceNumber ?? 0) + 1;
}

export function createDefaultRoomStore(): RoomStore {
  return {
    async context(token): Promise<RoomContext | null> {
      if (!TOKEN_PATTERN.test(token)) return null;
      return db.interviewSession.findFirst({
        where: {
          invitationTokenHash: hashInvitationToken(token),
          invitationRevokedAt: null,
        },
        select: {
          sessionId: true,
          userId: true,
          jobRole: true,
          jobDescription: true,
          evaluationMode: true,
          status: true,
        },
      });
    },

    async messages(sessionId) {
      const rows = await db.conversationMessage.findMany({
        where: { sessionId },
        orderBy: { sequenceNumber: "asc" },
        select: {
          sequenceNumber: true,
          speakerType: true,
          messageKind: true,
          contentText: true,
          assessmentUnitId: true,
        },
      });
      return rows.map(toEntry);
    },

    async activate(sessionId) {
      await db.interviewSession.update({
        where: { sessionId },
        data: { status: "active", startedAt: new Date() },
      });
    },

    async appendCandidate(sessionId, contentText, idempotencyKey, assessmentUnitId) {
      if (idempotencyKey) {
        const existing = await db.conversationMessage.findFirst({
          where: { sessionId, idempotencyKey },
        });
        if (existing) return { entry: toEntry(existing), created: false };
      }
      const message = await db.conversationMessage.create({
        data: {
          sessionId,
          sequenceNumber: await nextSequence(sessionId),
          speakerType: "candidate",
          messageKind: "candidate_response",
          contentText,
          idempotencyKey: idempotencyKey ?? null,
          assessmentUnitId,
        },
      });
      return { entry: toEntry(message), created: true };
    },

    async appendInterviewer(sessionId, contentText, messageKind, assessmentUnitId) {
      const message = await db.conversationMessage.create({
        data: {
          sessionId,
          sequenceNumber: await nextSequence(sessionId),
          speakerType: "interviewer",
          messageKind,
          contentText,
          assessmentUnitId,
        },
      });
      return toEntry(message);
    },

    async activeUnit(sessionId) {
      const unit = await db.interviewAssessmentUnit.findFirst({
        where: { sessionId, status: "open" },
        orderBy: { unitNumber: "desc" },
        select: { assessmentUnitId: true },
      });
      return unit?.assessmentUnitId ?? null;
    },

    async openUnit(sessionId, unitNumber) {
      const unit = await db.interviewAssessmentUnit.create({
        data: { sessionId, unitNumber },
        select: { assessmentUnitId: true },
      });
      return unit.assessmentUnitId;
    },

    async closeUnit(unitId) {
      await db.interviewAssessmentUnit.update({
        where: { assessmentUnitId: unitId },
        data: { status: "closed", closedAt: new Date() },
      });
    },

    async complete(sessionId) {
      await db.interviewSession.update({
        where: { sessionId },
        data: { status: "completed", completedAt: new Date() },
      });
    },
  };
}
