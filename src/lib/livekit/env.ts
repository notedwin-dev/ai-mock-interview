import { createHash } from "node:crypto";

/**
 * LiveKit Cloud/self-hosted credentials (server only). Read lazily so builds
 * and tests that do not use WebRTC stay hermetic. Never expose these values
 * to a client bundle or a route response.
 */
export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

export function getLiveKitConfig(): LiveKitConfig {
  const url = process.env["LIVEKIT_URL"];
  const apiKey = process.env["LIVEKIT_API_KEY"];
  const apiSecret = process.env["LIVEKIT_API_SECRET"];
  if (!url || !apiKey || !apiSecret) {
    throw new Error(
      "LiveKit WebRTC is not configured: set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.",
    );
  }
  return { url, apiKey, apiSecret };
}

/** Stable, privacy-preserving participant identity for an invitation link. */
export function participantIdentity(token: string): string {
  return `candidate-${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
}
