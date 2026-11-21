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

export const GENERATION_FIELDS: ReadonlyArray<{
  name: string;
  description: string;
  required: boolean;
}>;
export const TOOL_PARAMETERS: Record<string, unknown>;
export function greeting(userName?: string): string;
export function closingLine(): string;
export function buildInstructions(userName?: string): string;
export function mapAnswersToConfig(answers: GenerationAnswers): MappedGenerationConfig;
