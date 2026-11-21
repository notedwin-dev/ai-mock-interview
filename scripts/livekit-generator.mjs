import "dotenv/config";
import { fileURLToPath } from "node:url";
import { cli, defineAgent, voice, WorkerOptions, tool } from "@livekit/agents";
import * as google from "@livekit/agents-plugin-google";
import { z } from "zod";

/**
 * AIMIS voice interview-generation agent (Gemini Live on LiveKit).
 * Run with: node scripts/livekit-generator.mjs
 * It collects the interview briefing conversationally, then calls the backend
 * to create the interview. No Vapi and no new vendor keys are used.
 */
export const AGENT_NAME = "aimis-generator";
export const REALTIME_MODEL = "gemini-3.1-flash-live-preview";

const API_BASE = process.env.APP_URL || "http://localhost:3000";

export function buildInstructions() {
  return [
    "You are the AIMIS voice interview planner. Have a natural, concise conversation with the candidate to plan their mock interview.",
    "Collect exactly these details: the interview purpose, the target job role, the relevant experience level, the tech stack or key topics, how many questions they want, and how strict the feedback should be (Supportive, Balanced or Rigorous).",
    "Ask one short question at a time and listen to the answer. Confirm the details back before finishing.",
    "When every detail is known, call the submit_interview_config tool. Map experience level and number of questions into the job description text.",
    "Choose category general, technical or behavioural from the role and topics. Never invent facts or discuss protected traits.",
  ].join(" ");
}

const configSchema = z.object({
  purpose: z.string().min(1).max(500),
  jobRole: z.string().min(1).max(150),
  jobDescription: z.string().max(8000),
  strictness: z.enum(["supportive", "balanced", "rigorous"]),
  category: z.enum(["general", "technical", "behavioral"]),
});

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
    const { generationId, workerToken } = meta;
    if (!generationId || !workerToken) {
      console.error("generator worker missing generation capability");
      return;
    }

    const headers = {
      "content-type": "application/json",
      "x-aimis-worker-token": workerToken,
    };
    const caption = async (speaker, text) => {
      if (!text) return;
      try {
        await fetch(
          `${API_BASE}/api/v1/interviews/generation/${encodeURIComponent(generationId)}/worker/caption`,
          { method: "POST", headers, body: JSON.stringify({ speaker, text: text.slice(0, 1000) }) },
        );
      } catch {
        // Captioning is best-effort; the conversation itself continues.
      }
    };

    const submitInterviewConfig = tool({
      name: "submit_interview_config",
      description:
        "Submit the completed interview briefing once the purpose, job role, experience level, tech stack, question count and evaluation strictness are known. Call this exactly once.",
      parameters: configSchema,
      execute: async (args) => {
        const response = await fetch(
          `${API_BASE}/api/v1/interviews/generation/${encodeURIComponent(generationId)}/worker/complete`,
          { method: "POST", headers, body: JSON.stringify(args) },
        );
        const body = await response.json().catch(() => null);
        if (!response.ok) return { ok: false, message: body?.error?.message ?? "Could not create the interview." };
        return { ok: true, message: "The interview has been created and is ready to open." };
      },
    });

    const session = new voice.AgentSession({
      llm: new google.beta.realtime.RealtimeModel({
        model: REALTIME_MODEL,
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        instructions: buildInstructions(),
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
      agent: new voice.Agent({ instructions: buildInstructions(), tools: [submitInterviewConfig] }),
      room: ctx.room,
    });
    await session.generateReply({ instructions: "Greet the candidate and ask for the interview purpose." });
  },
});

if (process.env.AIMIS_AGENT_DISABLE_CLI !== "1") {
  cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
}
