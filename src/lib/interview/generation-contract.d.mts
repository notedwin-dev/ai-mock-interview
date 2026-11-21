export interface GenerationAnswers {
  role: string;
  type: string;
  level: string;
  techstack: string;
  amount: string;
  strictness: string;
}

export interface MappedGenerationConfig {
  purpose: string;
  jobRole: string;
  jobDescription: string;
  experienceLevel: string;
  techStack: string[];
  questionCount: number | undefined;
  strictness: "supportive" | "balanced" | "rigorous";
  category: "general" | "technical" | "behavioral";
}

export const CAPTION_TOPIC: string;

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
