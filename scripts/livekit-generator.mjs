import "dotenv/config";
import { fileURLToPath } from "node:url";
import { cli, defineAgent, voice, WorkerOptions } from "@livekit/agents";
import * as google from "@livekit/agents-plugin-google";
import {
  beginGathering,
  buildInstructions,
  closingLine,
  createPlanningState,
  greeting,
  recordAnswer,
} from "../src/lib/interview/generation-contract.mjs";

/**
 * AIMIS voice interview-generation worker (Gemini Live on LiveKit).
 * Run with: pnpm agent:generator
 *
 * Workflow (same shape as the approved reference, without Vapi):
 *   Say exact greeting -> gather five answers one at a time -> POST generated
 *   config to the app -> say closing line -> end call.
 *
 * The turn order is a deterministic state machine from the shared contract,
 * not an instruction the realtime model may ignore. See docs/UI-PLAN.md.
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
    const state = createPlanningState();
    let speaking = false;

    const session = new voice.AgentSession({
      llm: new google.beta.realtime.RealtimeModel({
        model: REALTIME_MODEL,
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        instructions: buildInstructions(userName),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      }),
    });

    /**
     * A RealtimeModel (Gemini Live) has no separate TTS model, so
     * `session.say(text)` throws. `generateReply` uses the realtime model's own
     * speech generation instead; the instruction forces verbatim wording so
     * the conversation still follows the contract exactly.
     */
    const say = async (text) => {
      if (!text) return;
      speaking = true;
      try {
        await session.generateReply({
          userInput: text,
          instructions:
            "Repeat the user's message word for word as your spoken reply. Do not answer it, paraphrase it, or add anything.",
        }).waitForPlayout();
      } finally {
        speaking = false;
      }
    };

    async function finish(answers) {
      // Raw answers only: the server validates and maps them before creating
      // the interview, so the worker never owns product rules.
      try {
        const response = await fetch(
          `${API_BASE}/api/v1/interviews/generation/${encodeURIComponent(generationId)}/worker/complete`,
          { method: "POST", headers, body: JSON.stringify(answers) },
        );
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error?.message ?? "generation failed");
        await say(closingLine());
      } catch (error) {
        console.error("generation failed", error instanceof Error ? error.message : "unknown");
        await say("I could not save your interview. Please try again.");
      } finally {
        setTimeout(() => ctx.shutdown("generation finished"), 500);
      }
    }

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
      if (!event.isFinal || speaking) return;
      void postCaption(API_BASE, generationId, headers, "candidate", event.transcript);
      const step = recordAnswer(state, event.transcript);
      if (!step) return;
      if (step.done) void finish(step.answers);
      else void say(step.question);
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
      if (event.item?.role === "assistant") {
        void postCaption(API_BASE, generationId, headers, "agent", itemText(event.item.content));
      }
    });

    await session.start({
      agent: new voice.Agent({ instructions: buildInstructions(userName) }),
      room: ctx.room,
    });

    // Say node: exact greeting, then the first gather question. The candidate
    // answers before the next question is asked.
    await say(greeting(userName));
    await say(beginGathering(state));
  },
});

if (process.env.AIMIS_AGENT_DISABLE_CLI !== "1") {
  cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
}
