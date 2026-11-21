import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { getLiveKitConfig } from "@/lib/livekit/env";
import { mintParticipantToken } from "./livekit-token";
import { dispatchGeneratorAgent } from "./livekit-dispatch";
import { agentConfigSchema, createInterviewFromAgentConfig } from "./agent";

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
      { room: roomName, generationId: id, workerToken },
      config,
    );
  } catch {
    // A worker outage does not invalidate the room; the UI reports the failure.
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
    invitationPath: record.invitationPath,
  };
}

export async function postCaption(id: string, workerToken: string, input: unknown) {
  await assertWorker(id, workerToken);
  const caption = captionSchema.parse(input);
  await db.interviewGeneration.update({
    where: { id },
    data: { captionJson: caption as unknown as never, status: "collecting" },
  });
}

export async function completeGeneration(id: string, workerToken: string, input: unknown) {
  const record = await assertWorker(id, workerToken);
  if (record.status === "completed") return { invitationPath: record.invitationPath };
  const config = agentConfigSchema.parse(input);
  const session = await createInterviewFromAgentConfig(record.userId, {
    config,
    missingFields: [],
  });
  await db.interviewGeneration.update({
    where: { id },
    data: { status: "completed", configJson: config as unknown as never, invitationPath: session.invitation.path },
  });
  return { invitationPath: session.invitation.path };
}
