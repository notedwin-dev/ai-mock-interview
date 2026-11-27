import "dotenv/config";
import { fileURLToPath } from "node:url";
import { cli, defineAgent, voice, WorkerOptions } from "@livekit/agents";
import * as google from "@livekit/agents-plugin-google";

/**
 * AIMIS LiveKit interviewer agent (owner direction: Gemini only).
 * Run with: node scripts/livekit-interviewer.mjs
 * It joins rooms where the app has created an explicit dispatch and uses the
 * owner-supplied free Gemini key. Camera is never used as AI input (ADR-005).
 */
export const AGENT_NAME = "aimis-interviewer";
export const REALTIME_MODEL = "gemini-3.1-flash-live-preview";

export function buildInstructions(meta) {
  const role = meta.jobRole || "the target role";
  const jd = meta.jobDescription || "no job description was supplied";
  return [
    "You are the AIMIS AI interviewer conducting a professional mock interview.",
    `The candidate is interviewing for ${role}. Job description context: ${jd}.`,
    "Ask one short question at a time, then listen. Use natural follow-ups to probe missing evidence.",
    "Never invent facts about the candidate, the role or the company. Do not discuss protected traits.",
    "Greet the candidate, explain the evaluation mode briefly, then ask the first question.",
  ].join(" ");
}

/** Normalizes a LiveKit chat item into a plain transcript line. */
export function itemText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
    .join("")
    .trim();
}

export default defineAgent({
  entry: async (ctx) => {
    let meta = {};
    try {
      meta = JSON.parse(ctx.job?.metadata ?? "{}");
    } catch {
      meta = {};
    }
    const instructions = buildInstructions(meta);
    const session = new voice.AgentSession({
      llm: new google.beta.realtime.RealtimeModel({
        model: REALTIME_MODEL,
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        instructions,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      }),
    });

    const persist = (speaker, text, createdAt) => {
      if (!meta.inviteToken || !text) return;
      const body = {
        messages: [{
          speaker,
          content: text,
          clientId: `lk-${createdAt || Date.now()}-${speaker}`,
        }],
      };
      const base = process.env.APP_URL || "http://localhost:3000";
      void fetch(
        `${base}/api/v1/interviews/invitations/${encodeURIComponent(meta.inviteToken)}/realtime/transcript`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      ).catch(() => undefined);
    };

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
      if (event.isFinal) persist("candidate", event.transcript);
    });
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
      if (event.item?.role === "assistant") {
        persist("interviewer", itemText(event.item.content), event.createdAt);
      }
    });

    await session.start({ agent: new voice.Agent({ instructions }), room: ctx.room });
    await session.generateReply({ instructions: "greet the candidate and ask the first interview question" });
  },
});

if (process.env.AIMIS_AGENT_DISABLE_CLI !== "1") {
  cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
}
