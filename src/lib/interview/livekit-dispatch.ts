import { AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import type { LiveKitConfig } from "@/lib/livekit/env";

/**
 * Shared LiveKit agent dispatch (TT-8 review dedup). Both roles run on ONE
 *  deployed agent (`AIMIS_AGENT_NAME`, Build-plan limit) and share the
 *  ensure-room → list → dispatch flow; only the metadata differs. The role is
 *  carried in metadata, not the agent name. Agent failures never block the
 *  candidate from entering the room.
 */
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

/**
 * Shared ensure-room → list → dispatch flow. Returns true when this call
 * created the agent dispatch, false when an AIMIS dispatch already exists for
 * the room (an existing dispatch is left untouched).
 *
 * LiveKit Cloud may auto-create an unnamed dispatch when a room appears; that
 * is not our agent and must not suppress our explicit dispatch, so only
 * entries named AIMIS_AGENT_NAME count as "already dispatched".
 */
async function ensureRoomAndDispatch(
  roomName: string,
  metadata: Record<string, unknown>,
  config: LiveKitConfig,
  deps: DispatchDeps,
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
    await createRooms(config).createRoom({ name: roomName });
  } catch {
    // The room may already exist — that is fine, dispatch it as-is.
  }

  const client = create(config);
  const existing = (await client.listDispatch(roomName)).filter(
    (entry) => (entry as { agentName?: string }).agentName === AIMIS_AGENT_NAME,
  );
  if (existing.length > 0) return false;

  await client.createDispatch(roomName, AIMIS_AGENT_NAME, {
    metadata: JSON.stringify(metadata),
  });
  return true;
}

/**
 * Dispatches the interviewer agent into the interview room, carrying the
 * interview context to the Gemini Live agent.
 */
export async function dispatchInterviewerAgent(
  context: DispatchContext,
  config: LiveKitConfig,
  deps: DispatchDeps = {},
): Promise<boolean> {
  return ensureRoomAndDispatch(
    context.room,
    {
      role: "interviewer",
      sessionId: context.room,
      inviteToken: context.inviteToken,
      jobRole: context.jobRole,
      jobDescription: context.jobDescription,
      evaluationMode: context.evaluationMode,
      experienceLevel: context.experienceLevel,
      techStack: context.techStack,
      questionCount: context.questionCount,
    },
    config,
    deps,
  );
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
  return ensureRoomAndDispatch(
    context.room,
    {
      role: "generator",
      generationId: context.generationId,
      workerToken: context.workerToken,
      room: context.room,
      userName: context.userName,
    },
    config,
    deps,
  );
}
