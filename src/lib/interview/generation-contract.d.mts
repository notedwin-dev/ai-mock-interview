export interface GenerationAnswers {
  role: string;
  type: string;
  level: string;
  techstack: string;
  amount: string;
}

export interface MappedGenerationConfig {
  purpose: string;
  jobRole: string;
  jobDescription: string;
  strictness: "supportive" | "balanced" | "rigorous";
  category: "general" | "technical" | "behavioral";
}

export interface PlanningState {
  index: number;
  answers: Partial<GenerationAnswers>;
  ready: boolean;
  done: boolean;
}

export type GatherStep =
  | { done: false; question: string }
  | { done: true; answers: GenerationAnswers }
  | null;

export const CAPTION_TOPIC: string;

export const GENERATION_FIELDS: ReadonlyArray<{
  name: string;
  description: string;
  required: boolean;
}>;
export function greeting(userName?: string): string;
export function closingLine(): string;
export function buildInstructions(userName?: string): string;
export function createPlanningState(): PlanningState;
export function beginGathering(state: PlanningState): string | null;
export function nextQuestion(state: PlanningState): string | null;
export function recordAnswer(state: PlanningState, transcript: string): GatherStep;
export function mapAnswersToConfig(answers: GenerationAnswers): MappedGenerationConfig;
