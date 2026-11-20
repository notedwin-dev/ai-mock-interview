import { createGoogle } from "@ai-sdk/google";

/**
 * Short-lived Gemini Live session credentials for the token-scoped room
 * (ADR-006 Option A; FR-INTERVIEW-003). The provider API key stays on the
 * server and is passed as a per-request header; only the ephemeral client
 * secret is returned to the browser.
 */
export interface RealtimeRoute {
  providerName: string;
  providerType: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

export interface RealtimeTokenResult {
  token: string;
  url: string;
  expiresAt?: number;
}

export interface RealtimeTokenDeps {
  createProvider?: (apiKey: string) => RealtimeProvider;
  getTokenFor?: (route: RealtimeRoute) => Promise<RealtimeTokenResult>;
}

interface RealtimeProvider {
  experimental_realtime: {
    getToken: (options: {
      model: string;
      sessionConfig: Record<string, unknown>;
      expiresAfterSeconds?: number;
    }) => Promise<RealtimeTokenResult>;
  };
}

const SESSION_CONFIG = {
  outputModalities: ["audio"],
  inputAudioTranscription: {},
  outputAudioTranscription: {},
};

export async function createRealtimeToken(
  route: RealtimeRoute,
  deps: RealtimeTokenDeps = {},
): Promise<RealtimeTokenResult> {
  if (deps.getTokenFor) return deps.getTokenFor(route);

  const provider = (
    deps.createProvider ??
    ((apiKey: string) =>
      createGoogle({ headers: { "x-goog-api-key": apiKey } }) as unknown as RealtimeProvider)
  )(route.apiKey);

  const result = await provider.experimental_realtime.getToken({
    model: route.modelId,
    sessionConfig: SESSION_CONFIG,
    expiresAfterSeconds: 600,
  });
  return { token: result.token, url: result.url, expiresAt: result.expiresAt };
}
