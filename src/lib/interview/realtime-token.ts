import { createGoogle } from "@ai-sdk/google";
import type { ProviderRoute } from "@/lib/providers/provider-route";
import type { Experimental_RealtimeSessionConfig } from "ai";

/**
 * Short-lived Gemini Live session credentials for the token-scoped room
 * (ADR-006 Option A; FR-INTERVIEW-003). The provider API key stays on the
 * server and is passed as a per-request header; only the ephemeral client
 * secret is returned to the browser.
 *
 * Provider gate (fail closed, FR-PROVIDER-006): the registry declares the
 * `realtime` capability for both the google and openai presets, but only the
 * Gemini Live wire is implemented (ADR-006 Option A). Resolving to any other
 * provider would drive the Google client with a foreign key/model, so it is
 * refused with a typed `unsupported_provider` error before any network call
 * instead of surfacing as a generic 502.
 */

export class RealtimeError extends Error {
  readonly code: "unsupported_provider" | "setup_failed";

  constructor(code: "unsupported_provider" | "setup_failed", message: string) {
    super(message);
    this.name = "RealtimeError";
    this.code = code;
  }
}

export interface RealtimeTokenResult {
  token: string;
  url: string;
  expiresAt?: number;
}

/**
 * The one live-session config shared by the server (baked into the client
 * secret at token creation — Google requires the full session config there)
 * and the browser (sent as `session-update` over the WebSocket). Built once
 * by `buildLiveInterviewInstructions` + this shape for both, so the live
 * interviewer is never half configured (instructions on one path only).
 */
export interface LiveSessionConfig {
  instructions: string;
  sessionConfig: Experimental_RealtimeSessionConfig;
}

/**
 * Structural match for the AI SDK's Google realtime provider. The SDK does
 * not export the option types it uses here, so the seam is typed against the
 * exact `getToken` contract (model + sessionConfig + expiry) instead of the
 * full provider object — no `as unknown as` escape, and hermetic tests can
 * satisfy it with a stub.
 */
interface RealtimeProvider {
  experimental_realtime: {
    getToken(options: {
      model: string;
      sessionConfig?: Experimental_RealtimeSessionConfig;
      expiresAfterSeconds?: number;
    }): Promise<RealtimeTokenResult>;
  };
}

/**
 * Single seam (the review flagged two alternative seams + a cast as
 * over-wide): the caller may inject a provider factory (tests) or use the
 * real Google provider built with the caller's own key.
 */
export interface RealtimeTokenDeps {
  createProvider?: (route: ProviderRoute) => RealtimeProvider;
}

export async function createRealtimeToken(
  route: ProviderRoute,
  session: LiveSessionConfig,
  deps: RealtimeTokenDeps = {},
): Promise<RealtimeTokenResult> {
  if (route.providerType !== "preset" || route.providerName !== "google") {
    throw new RealtimeError(
      "unsupported_provider",
      "Live voice currently supports the Google (Gemini Live) provider only. Configure Google for the realtime capability, or continue in text.",
    );
  }

  const createProvider =
    deps.createProvider ??
    // Pass the resolved key explicitly: the provider must never fall back to
    // the process-wide GOOGLE_GENERATIVE_AI_API_KEY (the interview runs on the
    // candidate's own configuration, ADR-0005).
    ((r: ProviderRoute) => createGoogle({ apiKey: r.apiKey }));
  const provider = createProvider(route);

  const result = await provider.experimental_realtime.getToken({
    model: route.modelId,
    sessionConfig: session.sessionConfig,
    expiresAfterSeconds: 600,
  });
  return { token: result.token, url: result.url, expiresAt: result.expiresAt };
}
