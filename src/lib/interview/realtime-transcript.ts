/**
 * Message-kind classification for native-realtime interviewer utterances
 * (FR-TRANSCRIPT-001/004, FR-INTERVIEW-007).
 *
 * A native realtime agent speaks free-form audio: only the final transcript
 * text reaches the server, so there is no structural message kind to persist.
 * Storing every utterance as `primary_question` made conversational
 * acknowledgements look like assessable questions and opened no assessment
 * unit. This module derives the kind deterministically from the text instead:
 *
 * - an utterance that asks the candidate for something is a question;
 * - a question that explicitly refers back to what the candidate just said is
 *   a follow-up, so it joins the active assessment unit;
 * - anything else is a conversational acknowledgement, which is persisted in
 *   the chronological transcript but never independently evaluated
 *   (FR-TRANSCRIPT-004 acceptance criteria).
 *
 * The transcript stays the source of truth (FR-TRANSCRIPT-005): grouping is
 * derived metadata, so a later re-classification can re-derive units without
 * rewriting a single message. Classification is deliberately conservative and
 * unit-tested; native audio carries no ground-truth label to compare against,
 * which is why an unrecognised question is treated as a new assessment area
 * rather than silently dropped.
 */

export const INTERVIEWER_MESSAGE_KINDS = [
  "primary_question",
  "follow_up_question",
  "acknowledgement",
] as const;

export type InterviewerMessageKind = (typeof INTERVIEWER_MESSAGE_KINDS)[number];

/**
 * Leading conversational filler that does not change what an utterance asks.
 * Stripped before the sentence-opening check so "Okay, so walk me through…"
 * is still recognised as a prompt.
 */
const LEADING_FILLER =
  /^(?:(?:and|but|so|now|okay|ok|alright|all right|right|well|great|good|perfect|nice|cool|excellent|interesting|sure|thanks|thank you|got it|i see|understood|lovely|wonderful|absolutely|of course)\b[\s,.:;!-]*)+/i;

/** Sentence openings that ask the candidate for evidence. */
const PROMPT_OPENER =
  /^(?:what|why|how|when|where|who|whom|whose|which|can|could|would|will|do|does|did|is|are|was|were|have|has|had|tell|describe|explain|walk|give|share|talk|outline|elaborate|expand|clarify|think|imagine|suppose)\b/i;

/**
 * Phrases that refer back to the answer the candidate just gave. Only explicit
 * back-references count: a question without one is treated as a new assessment
 * area (FR-TRANSCRIPT-004: a new primary question opens a new unit).
 */
const FOLLOW_UP_CUE =
  /\b(?:you (?:mentioned|said|noted|described|talked about)|earlier|previously|just now|a moment ago|your (?:answer|response|example)|that (?:answer|response|example|point)|elaborate|expand|in more detail|more detail|in more depth|go deeper|dig deeper|tell me more|say more|clarify|an example|one example)\b/i;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function withoutFiller(text: string): string {
  return text.replace(LEADING_FILLER, "").trim();
}

function lastSentence(text: string): string {
  const parts = text.split(/(?<=[.!?])\s+/).filter((part) => part.trim().length > 0);
  return parts[parts.length - 1] ?? text;
}

/** True when the utterance asks the candidate something (question or prompt). */
export function isQuestionUtterance(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  return (
    normalized.includes("?") ||
    PROMPT_OPENER.test(withoutFiller(normalized)) ||
    PROMPT_OPENER.test(withoutFiller(lastSentence(normalized)))
  );
}

/** Deterministic kind for one finalized native-realtime interviewer utterance. */
export function classifyInterviewerUtterance(text: string): InterviewerMessageKind {
  const normalized = normalize(text);
  if (!isQuestionUtterance(normalized)) return "acknowledgement";
  return FOLLOW_UP_CUE.test(normalized) ? "follow_up_question" : "primary_question";
}
