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

export function greeting(userName) {
  const name = typeof userName === "string" && userName.trim() ? userName.trim() : "there";
  return `Hello, ${name}! Let's prepare your interview. I'll ask you a few questions and generate a perfect interview just for you. Are you ready?`;
}

export function closingLine() {
  return "Your interview has been generated. Thank you for the call.";
}

/**
 * Deterministic conversation state. The worker drives the flow from this
 * state machine instead of trusting a realtime model to self-manage turns:
 *   Say (greeting) -> Gather (one question at a time) -> API request
 *   -> Say (closing line) -> End call.
 */
export function createPlanningState() {
  return { index: 0, answers: {}, ready: false, done: false };
}

/** Marks the greeting as finished, so only later speech counts as an answer. */
export function beginGathering(state) {
  state.ready = true;
  return nextQuestion(state);
}

export function nextQuestion(state) {
  if (!state.ready || state.done) return null;
  const field = GENERATION_FIELDS[state.index];
  return field ? field.description : null;
}

/**
 * Records one final user utterance as the answer to the current field.
 * Returns the next exact question, or `{ done: true, answers }` when all five
 * fields have been gathered. Empty/early utterances are ignored.
 */
export function recordAnswer(state, transcript) {
  if (!state.ready || state.done) return null;
  const text = String(transcript ?? "").trim();
  if (!text) return null;
  const field = GENERATION_FIELDS[state.index];
  if (!field) return null;
  state.answers[field.name] = text;
  state.index += 1;
  if (state.index >= GENERATION_FIELDS.length) {
    state.done = true;
    return { done: true, answers: { ...state.answers } };
  }
  return { done: false, question: GENERATION_FIELDS[state.index].description };
}

export function buildInstructions(userName) {
  return [
    `You are the AIMIS voice interview planner speaking with ${userName || "the candidate"}.`,
    "The application drives this conversation: speak only the exact text it gives you, listen, and answer naturally if the candidate asks what a question means.",
    "Never invent additional questions or skip ahead. Keep every response short and conversational.",
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
