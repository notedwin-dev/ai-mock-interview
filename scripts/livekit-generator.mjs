import "dotenv/config";
import { fileURLToPath } from "node:url";
import { cli, defineAgent, voice, WorkerOptions, tool } from "@livekit/agents";
import * as google from "@livekit/agents-plugin-google";
import {
  TOOL_PARAMETERS,
  buildInstructions,
  closingLine,
  greeting,
} from "../src/lib/interview/generation-contract.mjs";

/**
 * AIMIS voice interview-generation worker (Gemini Live on LiveKit).
 * Run with: pnpm agent:generator
 *
 * Workflow (mirrors the approved reference, without Vapi):
 *   start call -> exact greeting -> gather five answers one at a time
 *   -> submit_interview_config tool (server validates + creates the interview)
 *   -> closing line -> end call.
 * The contract module is shared with the server so prompts and fields cannot
 * drift between the two processes.
 */
export const AGENT_NAME = "aimis-generator";
export const REALTIME_MODEL = "gemini-3.1-flash-live-preview";

const API_BASE = process.env.APP_URL || "http://localhost:3000";

function itemText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("").trim();
}

function postCaption(base, generationId, headers, speaker, text) {
  if (!text) return Promise.resolve();
  return fetch(
    `${base}/api/v1/interviews/generation/${encodeURIComponent(generationId)}/worker/caption`,
    { method: "POST", headers, body: JSON.stringify({ speaker, text: text.slice(0, 1000) }) },
  ).catch(() => undefined);
}

export default defineAgent({
  entry: async (ctx) => {
    let meta = {};
    try {
      meta = JSON.parse(ctx.job?.metadata ?? "{}");
    } catch {
      meta = {};
    }
    const { generationId, workerToken, userName } = meta;
    if (!generationId || !workerToken) {
      console.error("generator worker missing generation capability");
      return;
    }

    const headers = {
      "content-type": "application/json",
      "x-aimis-worker-token": workerToken,
    };
    const caption = (speaker, text) => postCaption(API_BASE, generationId, headers, speaker, text);

    const submitInterviewConfig = tool({
      name: "submit_interview_config",
      description:
        "Submit the five gathered answers once role, type, level, techstack and amount are all known. Call exactly once.",
      parameters: TOOL_PARAMETERS,
      execute: async (answers) => {
        const response = await fetch(
          `${API_BASE}/api/v1/interviews/generation/${encodeURIComponent(generationId)}/worker/complete`,
          { method: "POST", headers, body: JSON.stringify(answers) },
        );
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          return { ok: false, message: body?.error?.message ?? "Could not create the interview." };
        }
        // Speak the closing line, then end the call as the workflow specifies.
        const handle = session.say(closingLine());
        await handle.waitForPlayout();
        setTimeout(() => ctx.shutdown("interview generated"), 500);
        return { ok: true, message: "Interview generated." };
      },
    });

    const session = new voice.AgentSession({
      llm: new google.beta.realtime.RealtimeModel({
        model: REALTIME_MODEL,
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        instructions: buildInstructions(userName),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      }),
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
      if (event.isFinal) void caption("candidate", event.transcript);
    });
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
      if (event.item?.role === "assistant") void caption("agent", itemText(event.item.content));
    });

    await session.start({
      agent: new voice.Agent({
        instructions: buildInstructions(userName),
        tools: [submitInterviewConfig],
      }),
      room: ctx.room,
    });
    // Start the call with the exact greeting from the approved workflow.
    await session.say(greeting(userName)).waitForPlayout();
  },
});

if (process.env.AIMIS_AGENT_DISABLE_CLI !== "1") {
  cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
}
