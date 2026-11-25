import { createGoogle } from "@ai-sdk/google";
import {
  AIMIS_ELEVENLABS_REALTIME_MODEL_ID,
  X_GOOG_API_KEY_HEADER,
  XI_API_KEY_HEADER,
} from "@/lib/utils/constants";

/**
 * Short-lived realtime session credentials for the token-scoped room
 * (ADR-006 Option A; FR-INTERVIEW-003). The provider API key stays on the
 * server; only the ephemeral per-connection credential (Google auth session
 * token / ElevenLabs client secret) is returned to the browser.
 *
 * Provider routing (owner decision 2026-11-25):
 * - Google keeps the `@ai-sdk/google` `experimental_realtime.getToken` wire.
 * - ElevenLabs uses its OpenAI-compatible Realtime API: the backend mints a
 *   short-lived `client_secret` from the stored key (which never reaches the
 *   browser) and the browser opens
 *   `wss://api.elevenlabs.io/v1/convai/realtime` with that secret as its
 *   API key. No hosted agent/voice payload is needed to open the session —
 *   the admin-fixed model and voice are chosen at connect time.
 * - OpenAI realtime remains a typed, fail-closed "unsupported" error: it
 *   requires a paid account and has no free tier to verify against, so it is
 *   never silently wired to a guessed endpoint.
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
  /** Injectable HTTP client for the ElevenLabs mint (tests, probe fetch). */
  fetchImpl?: typeof fetch;
  /** Injectable clock for expiry arithmetic (tests). */
  now?: () => number;
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

/**
 * Admin-fixed model ID for the ElevenLabs realtime entry (owner decision
 * 2026-11-25, verified against the official docs). The value lives in the
 * shared constants (`AIMIS_ELEVENLABS_REALTIME_MODEL_ID`) so the token
 * minter, the admin catalogue and any future agent consumer all stay in
 * lockstep; this alias keeps the minter's own import surface stable.
 */
export const ELEVENLABS_REALTIME_MODEL_ID = AIMIS_ELEVENLABS_REALTIME_MODEL_ID;
/** OpenAI-compatible Realtime wire — the only URL the browser is given. */
export const ELEVENLABS_REALTIME_WS_URL = "wss://api.elevenlabs.io/v1/convai/realtime";
/** Provider API base for the mint call; the model is admin-fixed, never user-editable. */
export const ELEVENLABS_REALTIME_API_BASE = "https://api.elevenlabs.io";
/**
 * Short-lived client secret endpoint (xi-api-key header). Verified live
 * 2026-11-25: POST /v1/convai/realtime/client_secrets with a `session`
 * (OpenAI-compatible) and `expires_after` body returns `{ value, expires_at, session }`.
 */
const ELEVENLABS_CLIENT_SECRET_PATH = "/v1/convai/realtime/client_secrets";
/** Assumed client-secret TTL; the value is documented, not silently substituted. */
const CLIENT_SECRET_TTL_SECONDS = 600;

export type RealtimeTokenErrorCode =
  /** No verified wire for this provider (openai paid-only / fish-audio / unknown). */
  | "unsupported_provider"
  /** The stored provider credential was rejected. */
  | "authentication_failed"
  /** The provider rate-limited the mint request. */
  | "rate_limited"
  /** Any other provider/setup failure (network, empty secret, malformed body). */
  | "provider_error";

/**
 * Typed realtime setup failure. `detail` is a sanitized, user-safe reason: it
 * never carries credential material (no xi-api-key value, no full provider
 * response body). The message wording is chosen so a caller that classifies
 * by message (e.g. the capability probe) maps it to the right bucket.
 */
export class RealtimeTokenError extends Error {
  readonly providerName: string;
  readonly errorCode: RealtimeTokenErrorCode;
  /** Provider HTTP status, when the provider answered (else undefined). */
  readonly status?: number;
  readonly detail: string;

  constructor(
    providerName: string,
    errorCode: RealtimeTokenErrorCode,
    detail: string,
    status?: number,
  ) {
    super(detail);
    this.name = "RealtimeTokenError";
    this.providerName = providerName;
    this.errorCode = errorCode;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Sanitizes a provider error body down to a short, safe reason: extracts a
 * provider `message`/`error` string, redacts anything that looks like an
 * ElevenLabs key, and truncates. The raw body is never returned.
 */
function sanitizedProviderReason(body: string): string {
  const providerMessage = (
    body.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ??
    body.match(/"error"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ??
    ""
  )
    // ElevenLabs key shape: sk_ + long token.
    .replace(/sk_[0-9A-Za-z_-]{8,}/g, "[redacted]")
    .slice(0, 300);
  return providerMessage;
}

/**
 * Mints the short-lived ElevenLabs client secret — the only credential the
 * browser ever sees. The stored key travels server-side in the `xi-api-key`
 * header and is never part of the returned token, URL, expiry or error.
 */
async function mintElevenLabsClientSecret(
  route: RealtimeRoute,
  deps: RealtimeTokenDeps,
): Promise<RealtimeTokenResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());

  let response: Response;
  try {
    response = await fetchImpl(
      `${ELEVENLABS_REALTIME_API_BASE}${ELEVENLABS_CLIENT_SECRET_PATH}`,
      {
        method: "POST",
        headers: {
          [XI_API_KEY_HEADER]: route.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // The provider uses the OpenAI Realtime wire (snake_case), while
          // SESSION_CONFIG above is camelCase for the Google AI SDK.
          session: {
            type: "realtime",
            model: route.modelId,
            output_modalities: ["audio"],
          },
          expires_after: { seconds: CLIENT_SECRET_TTL_SECONDS },
        }),
      },
    );
  } catch {
    // Network/DNS/transport failure — the endpoint was not reached.
    throw new RealtimeTokenError(
      route.providerName,
      "provider_error",
      "Could not reach the ElevenLabs realtime endpoint.",
    );
  }

  const text = await response.text();
  if (!response.ok) {
    const lower = `${response.status} ${text}`.toLowerCase();
    if (
      response.status === 401 ||
      response.status === 403 ||
      /api[ _]?key not valid|invalid api key|unauthorized|permission_denied|authentication/.test(lower)
    ) {
      throw new RealtimeTokenError(
        route.providerName,
        "authentication_failed",
        "API key not valid — the provider rejected the credential.",
        response.status,
      );
    }
    if (response.status === 429 || /quota|rate[ _]?limit|resource_exhausted/.test(lower)) {
      throw new RealtimeTokenError(
        route.providerName,
        "rate_limited",
        "The provider rate-limited the realtime session request.",
        response.status,
      );
    }
    throw new RealtimeTokenError(
      route.providerName,
      "provider_error",
      sanitizedProviderReason(text) ||
        "The provider rejected the realtime session setup.",
      response.status,
    );
  }

  let payload: { value?: unknown; expires_at?: unknown };
  try {
    payload = JSON.parse(text) as { value?: unknown; expires_at?: unknown };
  } catch {
    throw new RealtimeTokenError(
      route.providerName,
      "provider_error",
      "The provider returned a malformed realtime secret response.",
      response.status,
    );
  }

  // The live endpoint returns `{ value, expires_at, session }` (verified
  // 2026-11-25); accept the documented shape only — no silent fallback.
  const clientSecret = payload.value;
  if (typeof clientSecret !== "string" || clientSecret.length === 0) {
    throw new RealtimeTokenError(
      route.providerName,
      "provider_error",
      "The provider returned an empty realtime client secret.",
      response.status,
    );
  }
  const expiresAt =
    typeof payload.expires_at === "number"
      ? payload.expires_at * 1000
      : now() + CLIENT_SECRET_TTL_SECONDS * 1000;

  return {
    token: clientSecret,
    url: ELEVENLABS_REALTIME_WS_URL,
    expiresAt,
  };
}

export async function createRealtimeToken(
  route: RealtimeRoute,
  deps: RealtimeTokenDeps = {},
): Promise<RealtimeTokenResult> {
  if (deps.getTokenFor) return deps.getTokenFor(route);

  switch (route.providerName) {
    case "elevenlabs":
      // ElevenLabs preset rows speak the documented native wire; the model is
      // admin-fixed upstream (realtime-models.ts), never user-substituted.
      return mintElevenLabsClientSecret(route, deps);
    case "google": {
      const provider = (
        deps.createProvider ??
        ((apiKey: string) =>
          createGoogle({ headers: { [X_GOOG_API_KEY_HEADER]: apiKey } }) as unknown as RealtimeProvider)
      )(route.apiKey);
      const result = await provider.experimental_realtime.getToken({
        model: route.modelId,
        sessionConfig: SESSION_CONFIG,
        expiresAfterSeconds: 600,
      });
      return { token: result.token, url: result.url, expiresAt: result.expiresAt };
    }
    default:
      // Fail closed: no verified wire for this provider (openai realtime is
      // paid-only with no free tier to verify; fish-audio realtime is
      // paid-only). Never invent a model or silently switch providers.
      throw new RealtimeTokenError(
        route.providerName,
        "unsupported_provider",
        `Realtime sessions are not supported for provider "${route.providerName}".`,
      );
  }
}
