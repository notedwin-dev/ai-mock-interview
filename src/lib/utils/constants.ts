/**
 * Typed re-export of the shared runtime constants. The runtime source of truth
 * is `./constants.mjs` (plain ESM, also imported by the standalone LiveKit
 * agent worker); this file exists so TypeScript consumers in the Next.js app
 * import the value through a typed surface. The `.mjs` file has no adjacent
 * `.d.mts`, so the literal types below are the declared surface.
 */
export { AIMIS_REALTIME_MODEL_ID, AIMIS_ELEVENLABS_REALTIME_MODEL_ID } from "./constants.mjs";
