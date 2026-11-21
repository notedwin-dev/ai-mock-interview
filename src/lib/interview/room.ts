import { generateStructured, type LlmRoute, type StructuredOptions } from "@/lib/ai/llm";
import type { TtsRoute } from "@/lib/ai/tts";
import { createDefaultRoomStore } from "@/lib/interview/room-store";
import { resolveForOutboundCall } from "@/lib/providers/config";
import { z } from "zod";

/**
 * Token-scoped live interview turn engine (FR-INTERVIEW-002/003/004; TT-8/11).
 * A link grants exactly one interview's conversation: no account session, no
 * other interviews, no profile data. Each turn persists the candidate message
 * and the interviewer reply chronologically, groups them into assessment
 * units (a new primary question opens a unit; follow-ups join the active one)
 * and is idempotent on the candidate's key.
 */

export interface RoomContext {
  sessionId: string;
  userId: string;
  jobRole: string;
  jobDescription: string | null;
  experienceLevel: string | null;
  techStack: string[];
  questionCount: number | null;
  evaluationMode: string;
  status: string;
}

export interface TranscriptEntry {
  sequenceNumber: number;
  speakerType: string;
  messageKind: string;
  contentText: string;
  assessmentUnitId: string | null;
}

/** One finalized native-realtime line, as delivered by the room client. */
export interface RealtimeTranscriptMessage {
  speaker: "candidate" | "interviewer";
  contentText: string;
  /** Client-generated event id: repeated deliveries are idempotent. */
  clientId: string;
}

export interface RoomStore {
  context(token: string): Promise<RoomContext | null>;
  messages(sessionId: string): Promise<TranscriptEntry[]>;
  activate(sessionId: string): Promise<void>;
  appendCandidate(
    sessionId: string,
    contentText: string,
    idempotencyKey: string | undefined,
    assessmentUnitId: string | null,
  ): Promise<{ entry: TranscriptEntry; created: boolean }>;
  appendInterviewer(
    sessionId: string,
    contentText: string,
    messageKind: string,
    assessmentUnitId: string | null,
  ): Promise<TranscriptEntry>;
  /** Opens the next unit and stores its first message in ONE locked transaction. */
  appendInterviewerWithNewUnit(
    sessionId: string,
    contentText: string,
  ): Promise<TranscriptEntry>;
  activeUnit(sessionId: string): Promise<string | null>;
  /** Opens the next assessment unit, closing any unit still open (FR-TRANSCRIPT-004). */
  openUnit(sessionId: string): Promise<string>;
  complete(sessionId: string): Promise<void>;
  /** Appends one finalized native-realtime line (idempotent on clientId). */
  appendRealtimeMessage(
    sessionId: string,
    message: RealtimeTranscriptMessage,
  ): Promise<TranscriptEntry>;
}

export interface RoomTurnInput {
  contentText: string;
  idempotencyKey?: string;
}

export interface RoomTurnResult {
  messages: TranscriptEntry[];
  endCall: boolean;
  created: boolean;
  /** MP3 bytes of the interviewer turn, base64 — null when no voice is configured. */
  audioBase64: string | null;
}

export type RoomErrorCode = "invitation_not_found" | "invalid_state" | "invalid_input";

export class RoomError extends Error {
  readonly code: RoomErrorCode;

  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.name = "RoomError";
    this.code = code;
  }
}

export const roomLlmOutputSchema = z
  .object({
    interviewerText: z.string().trim().min(1).max(2000),
    messageKind: z.enum(["primary_question", "follow_up_question", "transition"]),
    endCall: z.boolean(),
  })
  .strict();
export type RoomLlmOutput = z.infer<typeof roomLlmOutputSchema>;

/** Voice is opt-in at the route boundary: no TTS config means no audio, not a failure. */
export interface RoomTtsDeps {
  resolveRoute: (userId: string) => Promise<TtsRoute | null>;
  synthesize: (route: TtsRoute, text: string) => Promise<Uint8Array>;
}

export interface RoomDeps {
  store?: RoomStore;
  resolveRoute?: (userId: string) => Promise<LlmRoute>;
  generate?: (
    route: LlmRoute,
    options: StructuredOptions<RoomLlmOutput>,
  ) => Promise<RoomLlmOutput>;
  tts?: RoomTtsDeps;
}

export const MAX_PRIMARY_QUESTIONS = 6;

function roomInstructions(context: RoomContext, primaryCount: number): string {
  return [
    "You are the AIMIS AI interviewer in a live mock interview.",
    `Target role: ${context.jobRole}. Experience level: ${context.experienceLevel ?? "not supplied"}. Topics: ${context.techStack.join(", ") || "not supplied"}. Target question count: ${context.questionCount ?? "not specified"}. Evaluation mode: ${context.evaluationMode}.`,
    "Ask short, focused questions and never invent facts about the candidate.",
    "Use primary_question only for a new assessment area; use follow_up_question to probe the candidate's last answer; use transition to move on.",
    primaryCount >= MAX_PRIMARY_QUESTIONS
      ? "The interview is complete: reply with a brief closing transition and set endCall=true."
      : "Set endCall=true only after the interview is genuinely complete. Choose at most one follow-up per answer.",
  ].join(" ");
}

/** Runs one candidate turn and the interviewer's response, atomically in order. */
export async function runRoomTurn(
  token: string,
  input: unknown,
  deps: RoomDeps = {},
): Promise<RoomTurnResult> {
  let parsed: RoomTurnInput;
  try {
    parsed = z
      .object({
        contentText: z.string().trim().min(1).max(5000),
        idempotencyKey: z
          .string()
          .regex(/^[A-Za-z0-9._:-]{1,100}$/)
          .optional(),
      })
      .strict()
      .parse(input);
  } catch (error) {
    throw new RoomError(
      "invalid_input",
      error instanceof Error ? error.message : "Invalid interview turn.",
    );
  }

  const store = deps.store ?? createDefaultRoomStore();
  const context = await store.context(token);
  if (!context) throw new RoomError("invitation_not_found", "This interview link is not available.");
  if (context.status !== "scheduled" && context.status !== "active") {
    throw new RoomError("invalid_state", "This interview is not accepting turns.");
  }

  const activeUnitId = await store.activeUnit(context.sessionId);
  const candidate = await store.appendCandidate(
    context.sessionId,
    parsed.contentText,
    parsed.idempotencyKey,
    activeUnitId,
  );
  if (!candidate.created) {
    // A retried finalized submission returns the original transcript unchanged.
    return {
      messages: await store.messages(context.sessionId),
      endCall: false,
      created: false,
      audioBase64: null,
    };
  }

  if (context.status === "scheduled") await store.activate(context.sessionId);

  const history = await store.messages(context.sessionId);
  const primaryCount = history.filter((message) => message.messageKind === "primary_question").length;
  const route = await (deps.resolveRoute ?? (async (userId: string) => {
    const resolved = await resolveForOutboundCall(userId, "llm");
    return {
      providerName: resolved.providerName,
      providerType: resolved.providerType,
      baseUrl: resolved.baseUrl,
      modelId: resolved.modelId,
      apiKey: resolved.apiKey,
    };
  }))(context.userId);
  const generate = deps.generate ?? generateStructured;
  const output = roomLlmOutputSchema.parse(
    await generate(route, {
      schema: roomLlmOutputSchema,
      instructions: roomInstructions(context, primaryCount),
      prompt: history
        .map((message) => `${message.speakerType}(${message.messageKind}): ${message.contentText}`)
        .join("\n"),
    }),
  );

  let unitId = activeUnitId;
  // The schema's message_kind domain has no "transition": a closing or moving-on
  // remark is a conversational acknowledgement and is never independently
  // evaluated (FR-TRANSCRIPT-004).
  let persistedKind: "primary_question" | "follow_up_question" | "acknowledgement" =
    output.messageKind === "transition" ? "acknowledgement" : output.messageKind;
  // A follow-up needs an active unit to join; without one the question opens a
  // unit so no question ends up unassessable.
  if (persistedKind === "follow_up_question" && !unitId) persistedKind = "primary_question";
  if (persistedKind === "primary_question") {
    // One locked write: a concurrent realtime line cannot close the unit
    // between opening it and attaching this question.
    const entry = await store.appendInterviewerWithNewUnit(
      context.sessionId,
      output.interviewerText,
    );
    unitId = entry.assessmentUnitId;
  } else {
    if (persistedKind === "acknowledgement") unitId = null;
    await store.appendInterviewer(
      context.sessionId,
      output.interviewerText,
      persistedKind,
      unitId,
    );
  }

  // Voice is an enhancement on top of the persisted transcript: a missing or
  // failing TTS configuration never blocks the conversation (FR-INTERVIEW-003).
  let audioBase64: string | null = null;
  if (deps.tts) {
    try {
      const ttsRoute = await deps.tts.resolveRoute(context.userId);
      if (ttsRoute) {
        const audio = await deps.tts.synthesize(ttsRoute, output.interviewerText);
        audioBase64 = Buffer.from(audio).toString("base64");
      }
    } catch {
      audioBase64 = null;
    }
  }

  const endCall = output.endCall || primaryCount + 1 >= MAX_PRIMARY_QUESTIONS + 1;
  if (endCall) await store.complete(context.sessionId);
  return {
    messages: await store.messages(context.sessionId),
    endCall,
    created: true,
    audioBase64,
  };
}
