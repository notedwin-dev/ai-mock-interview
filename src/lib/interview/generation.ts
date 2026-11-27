import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { getLiveKitConfig } from "@/lib/livekit/env";
import { mintParticipantToken } from "./livekit-token";
import { dispatchGeneratorAgent } from "./livekit-dispatch";
import { createInterviewFromAgentConfig } from "./agent";
import {
  mapAnswersToConfig,
  type MappedGenerationConfig,
} from "./generation-contract.mjs";

/**
 * Voice-driven interview generation. The browser talks to a LiveKit room
 * hosted by the Gemini Live generator agent; this module owns the short-lived
 * generation record, the worker capability and the final interview creation.
 * No provider keys or worker tokens ever reach the browser.
 */
export class GenerationError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_worker" | "invalid_state" | "not_configured" | "invalid_input",
    message: string,
  ) {
    super(message);
  }
}

const captionSchema = z
  .object({
    speaker: z.enum(["agent", "candidate"]),
    text: z.string().trim().min(1).max(1000),
  })
  .strict();

/** The five values the voice planner gathers, kept in the shared contract. */
export const generationAnswersSchema = z
  .object({
    role: z.string().trim().min(1).max(150),
    type: z.string().trim().min(1).max(40),
    level: z.string().trim().min(1).max(120),
    techstack: z.string().trim().min(1).max(1000),
    amount: z.string().trim().min(1).max(40),
    strictness: z.string().trim().min(1).max(20),
  })
  .strict();

export type Caption = z.infer<typeof captionSchema>;

function hashWorkerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function assertWorker(recordId: string, workerToken: string) {
  const record = await db.interviewGeneration.findUnique({ where: { id: recordId } });
  if (!record) throw new GenerationError("not_found", "This generation session no longer exists.");
  const provided = hashWorkerToken(workerToken);
  const expected = Buffer.from(provided, "hex");
  const stored = Buffer.from(record.workerTokenHash, "hex");
  if (expected.length !== stored.length || !timingSafeEqual(expected, stored)) {
    throw new GenerationError("invalid_worker", "The generator credential was rejected.");
  }
  return record;
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  // Node's crypto.timingSafeEqual throws on length mismatch; the caller checks.
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function startGeneration(userId: string) {
  let config;
  try {
    config = getLiveKitConfig();
  } catch {
    throw new GenerationError("not_configured", "Voice generation is not configured on this server.");
  }

  const account = await db.userAccount.findUnique({
    where: { userId },
    select: {
      email: true,
      candidateProfile: { select: { displayName: true } },
    },
  });
  const userName = account?.candidateProfile?.displayName || account?.email.split("@")[0] || "there";

  const id = randomUUID();
  const roomName = `gen-${id}`;
  const workerToken = randomBytes(32).toString("base64url");
  const record = await db.interviewGeneration.create({
    data: {
      id,
      userId,
      roomName,
      workerTokenHash: hashWorkerToken(workerToken),
    },
  });

  const session = await mintParticipantToken(
    { room: roomName, identity: `candidate-${id.slice(0, 8)}`, displayName: "Candidate", url: config.url },
    { apiKey: config.apiKey, apiSecret: config.apiSecret },
  );
  try {
    await dispatchGeneratorAgent(
      { room: roomName, generationId: id, workerToken, userName },
      config,
    );
  } catch {
    // Do not report a successful generation when the planner never started:
    // the candidate would wait in an idle room. Only a sanitized error crosses
    // this boundary; provider error text may contain URLs or credentials.
    console.error("generator dispatch failed");
    throw new GenerationError("not_configured", "The interview planner could not be started. Try again.");
  }
  return { id: record.id, ...session };
}

export async function getGeneration(userId: string, id: string) {
  const record = await db.interviewGeneration.findFirst({ where: { id, userId } });
  if (!record) throw new GenerationError("not_found", "Generation session not found.");
  return {
    id: record.id,
    status: record.status,
    caption: (record.captionJson as unknown as Caption | null) ?? null,
    config: (record.configJson as unknown as MappedGenerationConfig | null) ?? null,
    invitationPath: record.invitationPath,
  };
}

export async function postCaption(id: string, workerToken: string, input: unknown) {
  await assertWorker(id, workerToken);
  const caption = captionSchema.parse(input);
  // Only the caption changes: a late caption must never reset a generation
  // that already completed or was confirmed. New records start collecting.
  await db.interviewGeneration.update({
    where: { id },
    data: { captionJson: caption as unknown as never },
  });
}

export async function completeGeneration(id: string, workerToken: string, input: unknown) {
  const record = await assertWorker(id, workerToken);
  if (record.status === "completed") return { invitationPath: record.invitationPath };
  const answers = generationAnswersSchema.parse(input);
  const config = mapAnswersToConfig(answers);
  const session = await createInterviewFromAgentConfig(record.userId, {
    config,
    missingFields: [],
  });
  await db.interviewGeneration.update({
    where: { id },
    data: {
      status: "completed",
      configJson: config as unknown as never,
      sessionId: session.sessionId,
      invitationPath: session.invitation.path,
    },
  });
  return { invitationPath: session.invitation.path };
}

/**
 * Applies the candidate's confirmed, structured configuration to the session
 * created by the planner. The model produces a zod-validated object; the UI
 * never posts free text.
 */
export async function confirmGeneration(
  userId: string,
  id: string,
  input: unknown,
): Promise<{ invitationPath: string }> {
  const record = await db.interviewGeneration.findFirst({ where: { id, userId } });
  if (!record) throw new GenerationError("not_found", "Generation session not found.");
  const { agentConfigSchema } = await import("./agent");
  const config = agentConfigSchema.parse(input);
  if (record.status === "confirmed" && record.sessionId) {
    // Replaying the same confirmation returns the original invitation. A
    // different configuration is a distinct outcome: it cannot rewrite the
    // session the candidate already reviewed.
    const stored = record.configJson as unknown as Record<string, unknown> | null;
    if (stored && JSON.stringify(stored) === JSON.stringify(config)) {
      return { invitationPath: record.invitationPath! };
    }
    throw new GenerationError(
      "invalid_state",
      "This generation was already confirmed with a different configuration.",
    );
  }
  if (record.status !== "completed" || !record.sessionId) {
    throw new GenerationError("invalid_state", "This generation is not ready to confirm.");
  }
  await db.interviewSession.update({
    where: { sessionId: record.sessionId },
    data: {
      jobRole: config.jobRole,
      jobDescription: config.jobDescription || null,
      experienceLevel: config.experienceLevel ?? null,
      techStack: config.techStack ? (config.techStack as unknown as never) : undefined,
      questionCount: config.questionCount ?? null,
      evaluationMode: config.strictness,
    },
  });
  await db.interviewGeneration.update({
    where: { id },
    data: { configJson: config as unknown as never, status: "confirmed" },
  });
  return { invitationPath: record.invitationPath! };
}
