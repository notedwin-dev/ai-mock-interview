/** Requirement-facing names are Supportive / Balanced / Rigorous. */
export function evaluationModeLabel(mode: string): string {
  return mode ? mode.charAt(0).toUpperCase() + mode.slice(1) : mode;
}
