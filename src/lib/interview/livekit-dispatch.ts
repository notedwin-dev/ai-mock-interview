import { AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import type { LiveKitConfig } from "@/lib/livekit/env";

/**
 * Explicit LiveKit agent dispatch (TT-8 WebRTC runtime). One dispatch per
 * interview room, carrying the interview context to the Gemini Live agent.
 * Agent failures never block the candidate from entering the room.
 */
/** One deployed LiveKit agent serves both roles (Build plan limit). */
export const AIMIS_AGENT_NAME = "aimis-agent";

export interface DispatchContext {
  room: string;
  inviteToken: string;
  jobRole: string;
  jobDescription: string | null;
  evaluationMode?: string;
  experienceLevel?: string | null;
  techStack?: string[];
  questionCount?: number | null;
}

interface DispatchClient {
  listDispatch(roomName: string): Promise<unknown[]>;
  createDispatch(
    roomName: string,
    agentName: string,
    options: { metadata: string },
  ): Promise<unknown>;
}

interface RoomClient {
  createRoom(options: { name: string }): Promise<unknown>;
}

export interface DispatchDeps {
  createClient?: (config: LiveKitConfig) => DispatchClient;
  createRoomClient?: (config: LiveKitConfig) => RoomClient;
}

/** LiveKit's HTTP API uses https even when participant connections use wss. */
export function apiHost(url: string): string {
  return url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
}

export async function dispatchInterviewerAgent(
  context: DispatchContext,
  config: LiveKitConfig,
  deps: DispatchDeps = {},
): Promise<boolean> {
  const create =
    deps.createClient ??
    ((cfg: LiveKitConfig) =>
      new AgentDispatchClient(apiHost(cfg.url), cfg.apiKey, cfg.apiSecret) as unknown as DispatchClient);

  // Dispatches require the room to exist; candidates have not connected yet.
  const createRooms =
    deps.createRoomClient ??
    ((cfg: LiveKitConfig) =>
      new RoomServiceClient(apiHost(cfg.url), cfg.apiKey, cfg.apiSecret) as unknown as RoomClient);
  try {
    await createRooms(config).createRoom({ name: context.room });
  } catch {
    // The room may already exist — that is fine, dispatch it as-is.
  }

  const client = create(config);
  // LiveKit Cloud may auto-create an unnamed dispatch when a room appears;
  // that is not our agent and must not suppress our explicit dispatch.
  const existing = (await client.listDispatch(context.room)).filter(
    (entry) =>
      (entry as { agentName?: string }).agentName === AIMIS_AGENT_NAME,
  );
  if (existing.length > 0) return false;

  await client.createDispatch(context.room, AIMIS_AGENT_NAME, {
    metadata: JSON.stringify({
      role: "interviewer",
      sessionId: context.room,
      inviteToken: context.inviteToken,
      jobRole: context.jobRole,
      jobDescription: context.jobDescription,
      evaluationMode: context.evaluationMode,
      experienceLevel: context.experienceLevel,
      techStack: context.techStack,
      questionCount: context.questionCount,
    }),
  });
  return true;
}

/**
 * Dispatches the voice generation agent into a dedicated, short-lived room.
 * The worker receives a one-shot capability to post captions and the final
 * configuration; that capability is never exposed to the browser.
 */
export async function dispatchGeneratorAgent(
  context: { room: string; generationId: string; workerToken: string; userName: string },
  config: LiveKitConfig,
  deps: DispatchDeps = {},
): Promise<boolean> {
  const create =
    deps.createClient ??
    ((cfg: LiveKitConfig) =>
      new AgentDispatchClient(apiHost(cfg.url), cfg.apiKey, cfg.apiSecret) as unknown as DispatchClient);
  const createRooms =
    deps.createRoomClient ??
    ((cfg: LiveKitConfig) =>
      new RoomServiceClient(apiHost(cfg.url), cfg.apiKey, cfg.apiSecret) as unknown as RoomClient);
  try {
    await createRooms(config).createRoom({ name: context.room });
  } catch {
    // Room already exists — dispatch as-is.
  }
  const client = create(config);
  const existing = (await client.listDispatch(context.room)).filter(
    (entry) => (entry as { agentName?: string }).agentName === AIMIS_AGENT_NAME,
  );
  if (existing.length > 0) return false;
  await client.createDispatch(context.room, AIMIS_AGENT_NAME, {
    metadata: JSON.stringify({
      role: "generator",
      generationId: context.generationId,
      workerToken: context.workerToken,
      room: context.room,
      userName: context.userName,
    }),
  });
  return true;
}
