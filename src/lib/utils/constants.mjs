/**
 * Shared AIMIS runtime constants.
 *
 * Kept as plain ESM (`.mjs`) so BOTH the Next.js server code and the standalone
 * LiveKit agent worker (`scripts/livekit-agent.mjs`) import the SAME value
 * without a bundler or TypeScript step. The agent image ships this file via
 * `COPY . .`; the worker imports it directly. The Next.js app imports the typed
 * re-export in `constants.ts`.
 *
 * Do NOT hardcode a provider model ID in the agent or the app: change it here
 * (and in the admin-fixed catalogue it is sourced from) so every consumer
 * stays in lockstep.
 */

/**
 * The exact model ID the LiveKit Gemini Live agent runs. Sourced from the
 * admin-fixed Google realtime entry (owner decision 2026-11-20, ADR-006): in
 * Pre-configured mode the model is fixed by the administrator and never
 * user-editable. The agent and the app derive from this single value so the
 * deployed worker and the candidate-facing configuration can never diverge.
 */
export const AIMIS_REALTIME_MODEL_ID = "gemini-3.8-live-extended-thinking";
