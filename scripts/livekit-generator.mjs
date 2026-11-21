import "dotenv/config";
import { fileURLToPath } from "node:url";
import { cli, defineAgent, voice, WorkerOptions } from "@livekit/agents";
import * as google from "@livekit/agents-plugin-google";
import {
  beginGathering,
  buildInstructions,
  CAPTION_TOPIC,
  closingLine,
  createPlanningState,
  greeting,
  recordAnswer,
} from "../src/lib/interview/generation-contract.mjs";

/**
 * AIMIS voice interview-generation worker (Gemini Live on LiveKit).
 * Run with: pnpm agent:generator
 *
 * Workflow: Say exact greeting -> gather five answers one at a time -> POST
 * config -> Say closing line -> End call.
 *
 * Turn-taking is MANUAL: the realtime model never commits a user turn on its
 * own, so it cannot start interviewing the candidate. The state machine in the
 * shared contract decides when to speak the next exact question.
 */
export const AGENT_NAME = "aimis-generator";
export const REALTIME_MODEL = "gemini-3.1-flash-live-preview";

const API_BASE = process.env.APP_URL || "http://localhost:3000";

function itemText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("").trim();
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
    const encoder = new TextEncoder();

    // Instant captions go straight to the browser over the room data channel;
    // the HTTP endpoint persists only final lines for late joiners/history.
    let lastCaptionText = "";
    let lastCaptionAt = 0;
    function publishCaption(speaker, text, isFinal) {
      const now = Date.now();
      // Interim transcripts can arrive many times per second. Skip duplicates
      // and cap them at 10/s; finals are always sent immediately.
      if (!isFinal && (text === lastCaptionText || now - lastCaptionAt < 100)) return;
      lastCaptionText = text;
      lastCaptionAt = now;
      const payload = encoder.encode(JSON.stringify({ speaker, text, isFinal }));
      void ctx.room.localParticipant.publishData(payload, {
        topic: CAPTION_TOPIC,
        reliable: isFinal,
      });
    }

    function persistCaption(speaker, text) {
      if (!text) return;
      void fetch(
        `${API_BASE}/api/v1/interviews/generation/${encodeURIComponent(generationId)}/worker/caption`,
        { method: "POST", headers, body: JSON.stringify({ speaker, text: text.slice(0, 1000) }) },
      ).catch(() => undefined);
    }

    const session = new voice.AgentSession({
      // Keep the realtime model's native turn detection and transcription.
      // Automatic replies are paused after start (below) so the model listens
      // and transcribes but never interviews the candidate on its own.
      llm: new google.beta.realtime.RealtimeModel({
        model: REALTIME_MODEL,
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        instructions: buildInstructions(userName),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      }),
    });

    /**
     * A RealtimeModel has no separate TTS model, so session.say() throws.
     * generateReply uses the model's own speech generation. The text is passed
     * ONLY as a one-turn instruction — never as userInput — so the agent speaks
     * the contract line instead of repeating the candidate's answer.
     */
    const say = async (text) => {
      if (!text) return;
      speaking = true;
      publishCaption("agent", text, true);
      try {
        // Explicit replies are allowed; automatic ones stay blocked by the
        // StopResponse hook on the agent.
        session.resumeReplyAuthorization();
        await session.generateReply({
          instructions: `Speak exactly these words to the candidate: "${text}". Do not answer, paraphrase, add anything, or repeat any earlier user message.`,
        }).waitForPlayout();
      } finally {
        session.pauseReplyAuthorization();
        speaking = false;
      }
    };

    async function finish(answers) {
      try {
        const response = await fetch(
          `${API_BASE}/api/v1/interviews/generation/${encodeURIComponent(generationId)}/worker/complete`,
          { method: "POST", headers, body: JSON.stringify(answers) },
        );
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error?.message ?? "generation failed");
        await say(closingLine());
        // Give TTS/playback a full tail before tearing the call down.
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        console.error("generation failed", error instanceof Error ? error.message : "unknown");
        await say("I could not save your interview. Please try again.");
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } finally {
        ctx.shutdown("generation finished");
      }
    }

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
      const text = String(event.transcript ?? "").trim();
      if (!text) return;
      // Stream interim transcript immediately; only finals advance the flow.
      publishCaption("candidate", text, event.isFinal);
      if (!event.isFinal || speaking) return;
      persistCaption("candidate", text);
      const step = recordAnswer(state, text);
      if (!step) return;
      if (step.done) void finish(step.answers);
      else void say(step.question);
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
      if (event.item?.role === "assistant") {
        const text = itemText(event.item.content);
        if (text && !speaking) publishCaption("agent", text, true);
      }
    });

    await session.start({
      agent: new voice.Agent({
        instructions: buildInstructions(userName),
        // Keep listening/transcribing, but never auto-reply to the candidate.
        onUserTurnCompleted: () => {
          throw new voice.StopResponse();
        },
      }),
      room: ctx.room,
    });
    session.pauseReplyAuthorization();

    // Say node: exact greeting, then the first gather question.
    await say(greeting(userName));
    await say(beginGathering(state));
  },
});

if (process.env.AIMIS_AGENT_DISABLE_CLI !== "1") {
  cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
}
