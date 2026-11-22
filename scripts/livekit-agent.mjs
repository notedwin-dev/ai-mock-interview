import "dotenv/config";
import { fileURLToPath } from "node:url";
import { cli, defineAgent, tool, voice, WorkerOptions } from "@livekit/agents";
import * as google from "@livekit/agents-plugin-google";
import {
  buildInstructions as buildPlannerInstructions,
  CAPTION_TOPIC,
  closingLine,
  greeting,
  TOOL_PARAMETERS,
} from "../src/lib/interview/generation-contract.mjs";
import { AIMIS_REALTIME_MODEL_ID } from "../src/lib/utils/constants.mjs";

/**
 * AIMIS single LiveKit agent (Gemini Live). One deployment serves both roles:
 *  - role "generator": plans an interview, submits structured answers
 *  - role "interviewer": conducts the mock interview
 * LiveKit Cloud Build plan allows one deployed agent, so the dispatch metadata
 * carries the role instead of using two agent names.
 */
export const AGENT_NAME = "aimis-agent";
// The agent's exact model ID is admin-fixed and shared with the app through the
// constants module — never hardcoded here (owner decision 2026-11-23).
export const REALTIME_MODEL = AIMIS_REALTIME_MODEL_ID;
const API_BASE = process.env.APP_URL || "http://localhost:3000";

/* ------------------------------ shared helpers ------------------------------ */

/** Normalizes a LiveKit chat item into a plain transcript line. */
export function itemText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
    .join("")
    .trim();
}

export function buildInstructions(meta) {
  const role = meta.jobRole || "the target role";
  const jd = meta.jobDescription || "no job description was supplied";
  const level = meta.experienceLevel || "not supplied";
  const topics = Array.isArray(meta.techStack) && meta.techStack.length
    ? meta.techStack.join(", ")
    : "not supplied";
  const count = meta.questionCount || "not specified";
  return [
    "You are the AIMIS AI interviewer conducting a professional mock interview.",
    `Target role: ${role}. Experience level: ${level}. Topics: ${topics}. Planned question count: ${count}. Evaluation mode: ${meta.evaluationMode || "balanced"}. Job description context: ${jd}.`,
    "Ask one short question at a time, then listen. Use natural follow-ups to probe missing evidence.",
    "Never invent facts about the candidate, the role or the company. Do not discuss protected traits.",
    "Greet the candidate, explain the evaluation mode briefly, then ask the first question.",
  ].join(" ");
}

function sessionFor(instructions) {
  return new voice.AgentSession({
    llm: new google.beta.realtime.RealtimeModel({
      model: REALTIME_MODEL,
      apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      instructions,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    }),
  });
}

function captionPublisher(ctx) {
  const encoder = new TextEncoder();
  let lastText = "";
  let lastAt = 0;
  function publish(speaker, text, isFinal) {
    if (!text) return;
    const now = Date.now();
    if (!isFinal && (text === lastText || now - lastAt < 100)) return;
    lastText = text;
    lastAt = now;
    void ctx.room.localParticipant.publishData(
      encoder.encode(JSON.stringify({ speaker, text: text.slice(0, 1000), isFinal })),
      { topic: CAPTION_TOPIC, reliable: isFinal },
    );
  }
  return publish;
}

/* ----------------------------- generator role ------------------------------- */

export async function runGeneratorJob(ctx, meta) {
  const { generationId, workerToken, userName } = meta;
  if (!generationId || !workerToken) {
    console.error("generator role missing generation capability");
    return;
  }
  const headers = { "content-type": "application/json", "x-aimis-worker-token": workerToken };
  const publish = captionPublisher(ctx);
  let speaking = false;

  const say = async (text) => {
    if (!text) return;
    speaking = true;
    publish("agent", text, true);
    try {
      await session.generateReply({
        instructions: `Speak exactly these words to the candidate: "${text}". Do not answer, paraphrase, add anything, or repeat an earlier user message.`,
      }).waitForPlayout();
    } finally {
      speaking = false;
    }
  };

  const submitInterviewConfig = tool({
    name: "submit_interview_config",
    description: "Submit all six gathered values once all questions have been answered. Call exactly once.",
    parameters: TOOL_PARAMETERS,
    execute: async (answers) => {
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
        await new Promise((resolve) => setTimeout(resolve, 2000));
        ctx.shutdown("generation finished");
      }
      return { ok: true };
    },
  });

  const session = sessionFor(buildPlannerInstructions(userName));
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
    const text = String(event.transcript ?? "").trim();
    if (!text) return;
    publish("candidate", text, event.isFinal);
    if (event.isFinal) {
      void fetch(
        `${API_BASE}/api/v1/interviews/generation/${encodeURIComponent(generationId)}/worker/caption`,
        { method: "POST", headers, body: JSON.stringify({ speaker: "candidate", text: text.slice(0, 1000) }) },
      ).catch(() => undefined);
    }
  });
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
    if (event.item?.role === "assistant" && !speaking) {
      publish("agent", itemText(event.item.content), true);
    }
  });

  await session.start({
    agent: new voice.Agent({ instructions: buildPlannerInstructions(userName), tools: [submitInterviewConfig] }),
    room: ctx.room,
  });
  await say(greeting(userName));
}

/* ----------------------------- interviewer role ----------------------------- */

export async function runInterviewerJob(ctx, meta) {
  const publish = captionPublisher(ctx);
  const session = sessionFor(buildInstructions(meta));
  let queue = Promise.resolve();
  let lineCounter = 0;

  const persist = (speaker, text, createdAt) => {
    if (!meta.inviteToken || !text) return queue;
    const clientId = `lk-${createdAt || Date.now()}-${speaker}-${++lineCounter}`;
    const body = { messages: [{ speaker, content: text, clientId }] };
    const url = `${API_BASE}/api/v1/interviews/invitations/${encodeURIComponent(meta.inviteToken)}/realtime/transcript`;
    queue = queue.then(async () => {
      let status = "network_error";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          status = String(response.status);
          if (response.ok) return;
        } catch {
          // retry once with the same client id
        }
      }
      console.error(`transcript persist failed clientId=${clientId} status=${status}`);
    });
    return queue;
  };

  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
    const text = String(event.transcript ?? "").trim();
    if (!text) return;
    publish("candidate", text, event.isFinal);
    if (event.isFinal) persist("candidate", text);
  });
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
    if (event.item?.role !== "assistant") return;
    const text = itemText(event.item.content);
    publish("agent", text, true);
    persist("interviewer", text, event.createdAt);
  });

  await session.start({ agent: new voice.Agent({ instructions: buildInstructions(meta) }), room: ctx.room });
  await session.generateReply({ instructions: "greet the candidate and ask the first interview question" });
}

/* --------------------------------- entry ----------------------------------- */

/** Defaults to interviewer so malformed/legacy metadata still serves a call. */
export function roleForMetadata(meta) {
  return meta?.role === "generator" ? "generator" : "interviewer";
}

export default defineAgent({
  entry: async (ctx) => {
    let meta = {};
    try {
      meta = JSON.parse(ctx.job?.metadata ?? "{}");
    } catch {
      meta = {};
    }
    if (roleForMetadata(meta) === "generator") await runGeneratorJob(ctx, meta);
    else await runInterviewerJob(ctx, meta);
  },
});

if (process.env.AIMIS_AGENT_DISABLE_CLI !== "1") {
  cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
}
