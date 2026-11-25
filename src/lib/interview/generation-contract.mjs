/**
 * Shared contract for the voice interview-planning workflow.
 *
 * Kept as plain ESM so the Next.js server code and the standalone LiveKit
 * worker import the SAME field definitions, prompt and mapping. The realtime
 * model owns the conversation; this module only defines WHAT to collect and
 * the exact prompt/tool contract it uses to do so.
 */

import { CAPTION_TOPIC } from "../utils/constants.mjs";

/**
 * LiveKit room data topic for instant captions during generation.
 * Re-exported from the shared constants module (OWNER-023: all shared
 * constants live in `lib/utils/constants.*`); this module keeps exporting
 * it so existing consumers — including the standalone agent — are unchanged.
 */
export { CAPTION_TOPIC };

export const GENERATION_FIELDS = [
  { name: "role", description: "What role would you like to train for?", required: true },
  {
    name: "type",
    description: "Are you aiming for a technical, behavioral or mixed interview?",
    required: true,
  },
  { name: "level", description: "What job experience level are you targeting?", required: true },
  {
    name: "techstack",
    description: "Which technologies or topics should the interview cover?",
    required: true,
  },
  {
    name: "amount",
    description: "How many questions would you like me to prepare for you?",
    required: true,
  },
  {
    name: "strictness",
    description: "How strict should the feedback be: Supportive, Balanced or Rigorous?",
    required: true,
  },
];

/** JSON schema for the realtime model's submit tool — generated from the fields. */
export const TOOL_PARAMETERS = {
  type: "object",
  properties: Object.fromEntries(
    GENERATION_FIELDS.map((field) => [field.name, { type: "string", description: field.description }]),
  ),
  required: GENERATION_FIELDS.map((field) => field.name),
  additionalProperties: false,
};

export function greeting(userName) {
  const name = typeof userName === "string" && userName.trim() ? userName.trim() : "there";
  return `Hello, ${name}! Let's prepare your interview. I'll ask you a few questions and generate a perfect interview just for you. Are you ready?`;
}

export function closingLine() {
  return "Your interview has been generated. Thank you for the call.";
}

/**
 * The model gets the COMPLETE ordered list of six questions and owns the flow.
 * It must ask them one at a time, wait for each answer, never start the mock
 * interview, and submit all six values through the tool when done.
 */
export function buildInstructions(userName) {
  const questions = GENERATION_FIELDS.map(
    (field, index) => `${index + 1}. ${field.description}`,
  ).join("\n");

  return [
    `You are the AIMIS voice interview planner speaking with ${userName || "the candidate"}.`,
    `Start the call by saying exactly: ${greeting(userName)}`,
    "Your ONLY job is to collect six details and generate an interview. You are NOT conducting the interview itself. Do not ask interview questions, do not test the candidate, and do not give feedback.",
    "Ask the following six questions IN ORDER, exactly one question at a time. Wait for the candidate's answer before asking the next one. Never skip a question, never reorder them, and never ask extra questions.",
    questions,
    "For the type, accept technical, behavioral or mixed. For the amount, accept a number.",
    "For strictness, accept exactly one of Supportive, Balanced or Rigorous.",
    "Briefly acknowledge each answer, then ask the next question on the list.",
    "When all six answers are known, call the submit_interview_config tool with the values you collected. Do not ask anything else.",
    `After the tool succeeds, say exactly: ${closingLine()}`,
    "Keep every response short and natural for voice. Never repeat the candidate's answer back to them.",
  ].join(" ");
}

const CATEGORY_BY_TYPE = {
  technical: "technical",
  behavioral: "behavioral",
  mixed: "general",
};

/** Turns the six submitted answers into the existing approved agent config. */
export function mapAnswersToConfig(answers) {
  const role = String(answers.role ?? "").trim();
  const type = String(answers.type ?? "").trim().toLowerCase();
  const level = String(answers.level ?? "").trim();
  const techstack = String(answers.techstack ?? "").trim();
  const amount = String(answers.amount ?? "").trim();
  const requestedStrictness = String(answers.strictness ?? "").trim().toLowerCase();
  const strictness = ["supportive", "balanced", "rigorous"].includes(requestedStrictness)
    ? requestedStrictness
    : "balanced";
  const count = Number.parseInt(amount, 10);
  return {
    purpose: `Prepare a ${type || "mixed"} interview for ${role}.`,
    jobRole: role,
    jobDescription: "",
    experienceLevel: level,
    techStack: techstack.split(/[,\n]+/).map((part) => part.trim()).filter(Boolean),
    questionCount: Number.isFinite(count) && count > 0 ? count : undefined,
    strictness,
    category: CATEGORY_BY_TYPE[type] ?? "general",
  };
}
