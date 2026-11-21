/**
 * Shared contract for the voice interview-planning workflow.
 *
 * Kept as plain ESM so the Next.js server code and the standalone LiveKit
 * worker import the SAME field definitions, prompts and mapping — no drifting
 * copies between the browser, the API and the agent.
 */

export const GENERATION_FIELDS = [
  {
    name: "role",
    description: "What role would you like to train for?",
    required: true,
  },
  {
    name: "type",
    description: "Are you aiming for a technical, behavioral or mixed interview?",
    required: true,
  },
  {
    name: "level",
    description: "What job experience level are you targeting?",
    required: true,
  },
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
];

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

export function buildInstructions(userName) {
  return [
    `You are the AIMIS voice interview planner speaking with ${userName || "the candidate"}.`,
    `Start with this exact greeting: ${greeting(userName)}`,
    "Then gather the five details ONE AT A TIME. Ask exactly one question, stop speaking, and wait for the candidate's answer before asking the next.",
    ...GENERATION_FIELDS.map((field, index) => `${index + 1}. ${field.description}`),
    "For the type, accept technical, behavioral or mixed. For the amount, accept a number.",
    "Briefly acknowledge each answer before asking the next question. Never ask several questions in one turn.",
    "When all five answers are known, call submit_interview_config exactly once. Do not ask anything else.",
    "After the tool succeeds, say the closing line and end the call.",
  ].join(" ");
}

const CATEGORY_BY_TYPE = {
  technical: "technical",
  behavioural: "behavioral",
  behavioral: "behavioral",
  mixed: "general",
};

/** Turns the five spoken answers into the existing approved agent config. */
export function mapAnswersToConfig(answers) {
  const role = String(answers.role ?? "").trim();
  const type = String(answers.type ?? "").trim().toLowerCase();
  const level = String(answers.level ?? "").trim();
  const techstack = String(answers.techstack ?? "").trim();
  const amount = String(answers.amount ?? "").trim();
  return {
    purpose: `Prepare a ${type || "mixed"} interview for ${role}.`,
    jobRole: role,
    jobDescription: [
      `Experience level: ${level}.`,
      `Tech stack: ${techstack}.`,
      `Number of questions: ${amount}.`,
    ].join(" "),
    strictness: "balanced",
    category: CATEGORY_BY_TYPE[type] ?? "general",
  };
}
