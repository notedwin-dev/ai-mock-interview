import { createGoogle } from "@ai-sdk/google";
import {
  AIMIS_ELEVENLABS_REALTIME_MODEL_ID,
  XI_API_KEY_HEADER,
} from "@/lib/utils/constants";
import type { ProviderRoute } from "@/lib/providers/provider-route";
import type { Experimental_RealtimeSessionConfig } from "ai";

/**
 * Short-lived realtime session credentials for the token-scoped room
 * (ADR-006 Option A; FR-INTERVIEW-003). The provider API key stays on the
 * server; only the ephemeral per-connection credential (Google auth session
 * token / ElevenLabs client secret) is returned to the browser.
 *
 * Provider routing (owner decision 2026-11-25):
 * - Google keeps the `@ai-sdk/google` `experimental_realtime.getToken` wire.
 *   The server builds the session config (instructions = role/JD/question
 *   budget, FR-INTERVIEW-003) and bakes it into the client secret; a caller
 *   cannot configure the live interviewer from the browser.
 * - ElevenLabs uses its OpenAI-compatible Realtime API: the backend mints a
 *   short-lived `client_secret` from the stored key (which never reaches the
 *   browser) and the browser opens the documented WebSocket with that secret.
 * - OpenAI realtime remains a typed, fail-closed "unsupported" error: it is
 *   paid-only with no free tier to verify against, so it is never silently
 *   wired to a guessed endpoint (FR-PROVIDER-006).
 *
 * Privacy gate: the Google provider is built with the RESOLVED route key, never
 * the process-wide GOOGLE_GENERATIVE_AI_API_KEY, and no credential material is
 * echoed in a result or a typed error (NFR-SEC-008).
 */

/** Legacy error surface kept for the token route and its tests. */
export class RealtimeError extends Error {
  readonly code: "unsupported_provider" | "setup_failed";

  constructor(code: "unsupported_provider" | "setup_failed", message: string) {
    super(message);
    this.name = "RealtimeError";
    this.code = code;
  }
}

/** Structural alias: the realtime minter consumes the resolved provider route. */
export type RealtimeRoute = ProviderRoute;

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
 * Neutral Google session config used by the capability probe (no interview
 * content): transcription flags stay enabled, instructions are supplied by
 * the caller when a real interview is being configured.
 */
const SESSION_CONFIG: Experimental_RealtimeSessionConfig = {
  outputModalities: ["audio"],
  inputAudioTranscription: {},
  outputAudioTranscription: {},
};

export interface RealtimeTokenDeps {
  /** Provider factory seam (tests); receives the whole resolved route so the
   *  key is passed explicitly and never read from the process environment. */
  createProvider?: (route: ProviderRoute) => RealtimeProvider;
  /** Short-circuit for hermetic tests / the probe's injected minter. */
  getTokenFor?: (route: RealtimeRoute) => Promise<RealtimeTokenResult>;
  /** Injectable HTTP client for the ElevenLabs mint (tests, probe fetch). */
  fetchImpl?: typeof fetch;
  /** Injectable clock for expiry arithmetic (tests). */
  now?: () => number;
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
 * Admin-fixed model ID for the ElevenLabs realtime entry (owner decision
 * 2026-11-25, verified against the official docs). The value lives in the
 * shared constants so the minter, admin catalogue and agent consumer stay in
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

/**
 * Mints a short-lived session credential. Two call shapes are supported so
 * both consumers keep their contract:
 * - `(route, session, deps)` — the interview route, which supplies the
 *   server-owned interview instructions;
 * - `(route, deps)` — the probe, which supplies a neutral config and an
 *   injected fetch for the ElevenLabs native mint.
 */
export function createRealtimeToken(
  route: ProviderRoute,
  session: LiveSessionConfig,
  deps?: RealtimeTokenDeps,
): Promise<RealtimeTokenResult>;
export function createRealtimeToken(
  route: ProviderRoute,
  deps?: RealtimeTokenDeps,
): Promise<RealtimeTokenResult>;
export async function createRealtimeToken(
  route: ProviderRoute,
  sessionOrDeps?: LiveSessionConfig | RealtimeTokenDeps,
  maybeDeps: RealtimeTokenDeps = {},
): Promise<RealtimeTokenResult> {
  // A session always carries `instructions`; a deps bag never does.
  const hasSession = !!sessionOrDeps && "instructions" in sessionOrDeps;
  const session = hasSession ? (sessionOrDeps as LiveSessionConfig) : undefined;
  const deps = hasSession
    ? maybeDeps
    : ((sessionOrDeps as RealtimeTokenDeps | undefined) ?? {});

  if (deps.getTokenFor) return deps.getTokenFor(route);

  switch (route.providerName) {
    case "elevenlabs":
      // ElevenLabs preset rows speak the documented native wire; the model is
      // admin-fixed upstream (realtime-models.ts), never user-substituted.
      return mintElevenLabsClientSecret(route, deps);
    case "google": {
      const provider = (
        deps.createProvider ??
        // Pass the resolved key explicitly: the provider must never fall back
        // to the process-wide GOOGLE_GENERATIVE_AI_API_KEY (ADR-0005). This
        // supersedes the header-based factory: `apiKey` is the SDK's own
        // explicit-key option, so no x-goog-api-key constant or cast is needed
        // here (the constant stays on the shared/probe wire surface).
        ((r: ProviderRoute) => createGoogle({ apiKey: r.apiKey }))
      )(route);
      const result = await provider.experimental_realtime.getToken({
        model: route.modelId,
        // The server-built interview config is baked into the client secret;
        // the probe supplies a neutral config instead.
        sessionConfig: session?.sessionConfig ?? SESSION_CONFIG,
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
