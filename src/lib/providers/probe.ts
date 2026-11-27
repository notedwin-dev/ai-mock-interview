import type { UserProviderConfiguration } from "@/generated/prisma/client";
import { db } from "@/lib/db";
// Reintroduced from the runtime batch: the realtime capability probe uses a
// short-lived native session token (never interview content) to prove the key.
import { createRealtimeToken, type LiveSessionConfig } from "@/lib/interview/realtime-token";
import { capabilitiesJsonSchema, ProviderConfigError, validateProviderTarget } from "./config";
import { ProviderCryptoError, decryptApiKey } from "./encryption";
import { getPresetAdapter, PRESET_MODEL_LIST_WIRES, type Capability } from "./registry";
import { evaluateBaseUrl } from "./ssrf";

/**
 * Capability probe service (FR-PROVIDER-006): independently verifies, per
 * enabled capability, that the endpoint is reachable, the credential is
 * accepted and the exact selected model can perform the capability — without
 * ever sending real interview content. Results distinguish authentication,
 * missing endpoint, unsupported model/capability, quota/rate-limit and
 * provider/server failures; a probe failure never falls back to another
 * model or provider.
 *
 * Probe wire shapes: the `openai` preset and every custom row speak the
 * OpenAI-compatible wire (`GET /models`, `POST /chat/completions`,
 * `POST /audio/speech`, `POST /audio/transcriptions`); the `fish-audio`
 * preset speaks its native TTS wire (`POST /v1/tts`, model selected by a
 * request header). Native realtime sessions (the `realtime` capability:
 * Gemini Live, OpenAI Realtime) negotiate the provider's own protocol and
 * always report skipped until the realtime runtime lands — they must never
 * reach the wires above. Model-list discovery (FR-PROVIDER-009) lives in the
 * same module and shares the wire handling: presets without an override use
 * `GET {base}/models` (Bearer); registry overrides (Google:
 * `GET /v1beta/models` with `x-goog-api-key`) are honoured by both
 * stored-row and candidate discovery. Other presets need their M2 adapters
 * and are reported as skipped, which does not validate the configuration. DNS-rebinding/redirect
 * pinning at connect time lands with the M2 adapter transport (see ssrf.ts
 * notes).
 *
 * Network access and row loading are injectable so tests stay hermetic; the
 * default implementation is the database + global fetch.
 */

export type ProbeErrorCode =
  | "network_unreachable"
  | "authentication_failed"
  | "endpoint_not_found"
  | "model_unsupported"
  | "rate_limited"
  | "provider_error";

export type CapabilityProbeStatus = "validated" | "failed" | "skipped";

export interface CapabilityProbeResult {
  capability: Capability;
  status: CapabilityProbeStatus;
  endpointReachable: boolean;
  credentialValid: boolean;
  /** Model IDs from the provider's model-list endpoint, when it supports one. */
  modelsDiscovered: string[] | null;
  /** Whether the exact selected model was accepted for this capability. */
  selectedModelAccepted: boolean | null;
  errorCode?: ProbeErrorCode;
  /** Human-readable failure detail; never includes credentials. */
  detail?: string;
}

export interface ConfigurationProbeResult {
  userProviderConfigurationId: string;
  providerName: string;
  /** Post-probe stored status: valid only when every capability validated. */
  credentialStatus: "unvalidated" | "valid" | "invalid";
  capabilities: CapabilityProbeResult[];
}

export interface ProbeDeps {
  load?: (
    userId: string,
    configurationId: string,
  ) => Promise<UserProviderConfiguration | null>;
  fetchImpl?: typeof fetch;
  /** Native realtime session setup (injectable so probes stay hermetic). */
  realtimeToken?: (
    route: {
      providerName: string;
      providerType: string;
      baseUrl: string;
      modelId: string;
      apiKey: string;
    },
    session?: LiveSessionConfig,
  ) => Promise<{ token: string; url: string }>;
  /**
   * Persists the post-probe credential status (default: the database).
   * `disable` is true exactly when the probe failed — a failed test must
   * prevent the capability being (or remaining) enabled (FR-PROVIDER-006).
   */
  save?: (
    configurationId: string,
    credentialStatus: "valid" | "invalid",
    disable: boolean,
  ) => Promise<void>;
}

function loadStoredRow(
  userId: string,
  configurationId: string,
): Promise<UserProviderConfiguration | null> {
  return db.userProviderConfiguration.findFirst({
    where: { userProviderConfigurationId: configurationId, userId },
  });
}

function saveStoredStatus(
  configurationId: string,
  credentialStatus: "valid" | "invalid",
  disable: boolean,
): Promise<void> {
  return db.userProviderConfiguration
    .update({
      where: { userProviderConfigurationId: configurationId },
      data: { credentialStatus, ...(disable ? { isEnabled: false } : {}) },
    })
    .then(() => undefined);
}

/**
 * Shared HTTP-status → probe-error-code classification (FR-PROVIDER-006
 * taxonomy). `stage` distinguishes the model-list step from the capability
 * ping where credential provability differs.
 */
function classifyHttpFailure(
  status: number,
  stage: "models" | "capability",
  bodyText?: string,
): { errorCode: ProbeErrorCode; detail: string; endpointReachable: boolean; credentialValid: boolean } {
  if (status === 401 || status === 403) {
    return { errorCode: "authentication_failed", detail: "The provider rejected the API key.", endpointReachable: true, credentialValid: false };
  }
  if (status === 402) {
    // Quota family (FR-PROVIDER-006): the key authenticated, but the account
    // has no credit or payment for this model — never an auth rejection.
    return { errorCode: "rate_limited", detail: "The provider accepted the key but the account has no credit or payment for this model.", endpointReachable: true, credentialValid: true };
  }
  if (status === 404) {
    return { errorCode: "endpoint_not_found", detail: "The provider has no such endpoint.", endpointReachable: true, credentialValid: stage !== "models" };
  }
  if (status === 400 && stage === "capability" && /model/i.test(bodyText ?? "")) {
    return { errorCode: "model_unsupported", detail: "The provider rejected the selected model for this capability.", endpointReachable: true, credentialValid: true };
  }
  if (status === 429) {
    // Throttled, not rejected: the request reached the provider's processing
    // under the supplied key. Quota/rate-limit stays distinct from auth.
    return { errorCode: "rate_limited", detail: "The provider rate-limited the probe.", endpointReachable: true, credentialValid: true };
  }
  if (status >= 500) {
    return { errorCode: "provider_error", detail: "The provider reported a server error.", endpointReachable: true, credentialValid: stage !== "models" };
  }
  return { errorCode: "provider_error", detail: `The provider rejected the probe (HTTP ${status}).`, endpointReachable: true, credentialValid: stage !== "models" };
}

async function classifyProbeFailure(
  error: unknown,
): Promise<{ errorCode: ProbeErrorCode; detail: string; endpointReachable: boolean; credentialValid: boolean }> {
  if (error instanceof ProviderCryptoError) {
    // Fail closed (ADR-0005): a credential that cannot be decrypted means the
    // stored key is unusable — the user must re-save it. Never fall back.
    return { errorCode: "authentication_failed", detail: "The stored credential could not be decrypted; re-save the configuration.", endpointReachable: false, credentialValid: false };
  }
  if (error instanceof ProbeHttpError) {
    return classifyHttpFailure(error.status, error.stage, error.bodyText);
  }
  if (error instanceof Error) {
    return { errorCode: "network_unreachable", detail: `The endpoint could not be reached. (${error.message})`, endpointReachable: false, credentialValid: false };
  }
  return { errorCode: "provider_error", detail: "The probe failed.", endpointReachable: false, credentialValid: false };
}

/**
 * Native realtime token failures arrive as provider SDK errors whose message
 * embeds the HTTP response. Surface a sanitized, actionable reason instead of
 * a generic "rejected setup" so a bad key is distinguishable from a quota or
 * a missing model. No credential material is ever echoed.
 */
function describeRealtimeError(error: unknown): {
  errorCode: ProbeErrorCode;
  detail: string;
  endpointReachable: boolean;
} {
  if (error instanceof ProviderCryptoError) {
    return {
      errorCode: "authentication_failed",
      detail: "The stored credential could not be decrypted; re-save the configuration.",
      endpointReachable: false,
    };
  }
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  const statusMatch = raw.match(/\b([45]\d{2})\b/);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  const providerMessage = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
  const sanitized = (providerMessage ?? "")
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, "[redacted]")
    .replace(/sk-[0-9A-Za-z_-]{8,}/g, "[redacted]")
    .slice(0, 300);

  if (/api[ _]?key not valid|api_key_invalid|invalid api key|unauthorized|permission_denied|authentication/.test(lower)) {
    return {
      errorCode: "authentication_failed",
      detail: "The provider rejected the API key.",
      endpointReachable: status !== null,
    };
  }
  if (/quota|rate[ _]?limit|resource_exhausted/.test(lower)) {
    return {
      errorCode: "rate_limited",
      detail: "The provider rate-limited the realtime session request.",
      endpointReachable: status !== null,
    };
  }
  if (status === 404 || /not[ _]?found|model.*(unsupported|not available)/.test(lower)) {
    return {
      errorCode: "model_unsupported",
      detail: "The provider does not expose the configured realtime model.",
      endpointReachable: status !== null,
    };
  }
  return {
    errorCode: "provider_error",
    detail: sanitized || "The provider rejected the realtime session setup.",
    endpointReachable: status !== null,
  };
}

export class ProbeHttpError extends Error {
  readonly status: number;
  readonly stage: "models" | "capability";
  /** Sanitised provider error body text (never includes credentials). */
  readonly bodyText?: string;

  constructor(status: number, stage: "models" | "capability", bodyText?: string) {
    super(`Provider probe HTTP ${status} at ${stage}`);
    this.name = "ProbeHttpError";
    this.status = status;
    this.stage = stage;
    this.bodyText = bodyText;
  }
}

/**
 * Presets the probe can verify natively today: `openai`, `deepseek`,
 * `zai-glm` and `qwen` speak the OpenAI-compatible wire shape, and
 * `fish-audio` speaks its own documented TTS wire (see the capability ping
 * below). The remaining presets (`anthropic`, `google`, `elevenlabs`) still
 * await their native-protocol adapters and are reported skipped — never
 * silently "validated".
 */
const PROBEABLE_PRESETS = new Set<string>([
  "openai",
  "fish-audio",
  "deepseek",
  "zai-glm",
  "qwen",
]);

/**
 * Runs the probe for one configuration and returns per-capability results.
 * Nothing here logs or persists credentials; the stored credential status is
 * updated only through the caller-facing status write-back (slice continues).
 */
export async function probeProviderConfiguration(
  userId: string,
  configurationId: string,
  deps: ProbeDeps = {},
): Promise<ConfigurationProbeResult> {
  const load = deps.load ?? loadStoredRow;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const save = deps.save ?? saveStoredStatus;

  const row = await load(userId, configurationId);
  if (!row) {
    throw new ProviderConfigError("not_found", "Provider configuration not found.");
  }

  const capabilities = capabilitiesJsonSchema.parse(row.capabilitiesJson);
  const results: CapabilityProbeResult[] = [];

  // The fish-audio preset speaks a native wire instead of OpenAI-compatible
  // endpoints, and it has no OpenAI-shaped model list (`GET /model` lists
  // community voices, not TTS models) — so no model list is ever consumed.
  const isFishAudioPreset = row.providerType === "preset" && row.providerName === "fish-audio";

  for (const capability of Object.keys(capabilities) as Capability[]) {
    const settings = capabilities[capability]!;

    // Native realtime sessions (Gemini Live, OpenAI Realtime) negotiate the
    // provider's own realtime protocol — they must never be driven over the
    // OpenAI-compatible wires below. Native realtime verification lands with
    // the realtime interview runtime (register Option A, built after the
    // custom pipeline is stable), so realtime reports skipped: status-neutral,
    // exactly like the not-yet-adaptered presets.
    if (capability === "realtime") {
      // Combine both sides: keep the injectable Gemini Live session-token
      // verification and the sanitised realtime error classification from the
      // runtime batch, while keeping our status-neutral wording for a config
      // that cannot be verified here. No interview content ever crosses a wire.
      const presetBase =
        row.providerType === "preset" ? getPresetAdapter(row.providerName)?.defaultBaseUrl : null;
      const realtimeBase = presetBase ?? row.baseUrl ?? "";
      // createRealtimeToken only supports the preset Google route. A custom
      // target that merely points at a Gemini base URL cannot be verified here
      // and stays status-neutral (skipped); injected tokens (tests) still run.
      const isGemini =
        Boolean(deps.realtimeToken) ||
        (row.providerType === "preset" && row.providerName === "google");
      if (!isGemini) {
        results.push({
          capability,
          status: "skipped",
          endpointReachable: false,
          credentialValid: false,
          modelsDiscovered: null,
          selectedModelAccepted: null,
          detail: "Native realtime sessions are verified with the realtime interview runtime; this test does not contact the provider yet.",
        });
        continue;
      }
      try {
        const apiKey = decryptApiKey(new TextDecoder().decode(row.encryptedApiKey!));
        // The live token API now requires a session config; supply a neutral
        // one (no interview content) rather than dropping the probe feature.
        const probeInstructions = "Connectivity probe only — no interview content is sent.";
        const session = await (deps.realtimeToken ?? createRealtimeToken)(
          {
            providerName: row.providerName,
            providerType: row.providerType as "custom" | "preset",
            baseUrl: realtimeBase,
            modelId: settings.modelId,
            apiKey,
          },
          {
            instructions: probeInstructions,
            sessionConfig: { instructions: probeInstructions },
          },
        );
        if (!session.token || !session.url) throw new Error("empty realtime session");
        results.push({
          capability,
          status: "validated",
          endpointReachable: true,
          credentialValid: true,
          modelsDiscovered: null,
          selectedModelAccepted: null,
          detail: "Realtime session token accepted; no interview audio was sent.",
        });
      } catch (error) {
        const reason = describeRealtimeError(error);
        results.push({
          capability,
          status: "failed",
          endpointReachable: reason.endpointReachable,
          credentialValid: false,
          modelsDiscovered: null,
          selectedModelAccepted: null,
          errorCode: reason.errorCode,
          detail: reason.detail,
        });
      }
      continue;
    }

    // Base URL: custom rows carry their own; presets resolve via the registry.
    let baseUrl: string | null = row.baseUrl;
    if (row.providerType === "preset") {
      baseUrl = getPresetAdapter(row.providerName)?.defaultBaseUrl ?? null;
      if (!PROBEABLE_PRESETS.has(row.providerName)) {
        results.push({
          capability,
          status: "skipped",
          endpointReachable: false,
          credentialValid: false,
          modelsDiscovered: null,
          selectedModelAccepted: null,
          detail: "Capability probe requires the provider's M2 adapter.",
        });
        continue;
      }
    }

    const urlDecision = evaluateBaseUrl(baseUrl ?? "");
    if (!urlDecision.ok) {
      results.push({
        capability,
        status: "failed",
        endpointReachable: false,
        credentialValid: false,
        modelsDiscovered: null,
        selectedModelAccepted: null,
        errorCode: "network_unreachable",
        detail: "The configured Base URL is not a usable endpoint.",
      });
      continue;
    }

    try {
      const apiKey = decryptApiKey(new TextDecoder().decode(row.encryptedApiKey!));
      const headers = { authorization: `Bearer ${apiKey}` };

      // Step 1: model-list discovery (when the provider supports it), on the
      // same wire as model discovery (FR-PROVIDER-009). Auth and rate-limit
      // rejections are real verification failures; a missing list endpoint
      // (404/405) returns null and is not a capability failure. fish-audio
      // has no such endpoint, so nothing is requested for it.
      let modelsDiscovered: string[] | null = null;
      if (!isFishAudioPreset) {
        modelsDiscovered = await fetchModelList(
          urlDecision.normalizedUrl,
          apiKey,
          row.providerType === "preset" ? row.providerName : null,
          fetchImpl,
        );
      }

      // Step 2: capability-specific ping with no real interview content.
      // Each capability gets its own endpoint and wire shape; the LLM-shaped
      // ping (chat/completions) serves llm and scorer.
      const root = stripTrailingSlash(urlDecision.normalizedUrl);
      let pingUrl: string;
      let pingRequest: RequestInit;
      if (capability === "tts") {
        if (isFishAudioPreset) {
          // Native Fish Audio TTS: model selection travels in the `model`
          // request header — omitting it silently serves the PAID s2.1-pro —
          // so the header always carries the exact configured model id.
          pingUrl = `${root}/v1/tts`;
          pingRequest = {
            method: "POST",
            headers: { ...headers, "content-type": "application/json", model: settings.modelId },
            body: JSON.stringify({ text: "ping", format: "mp3" }),
          };
        } else {
          pingUrl = `${root}/audio/speech`;
          pingRequest = {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              model: settings.modelId,
              input: "ping",
              voice: "alloy",
              response_format: "mp3",
            }),
          };
        }
      } else if (capability === "asr") {
        pingUrl = `${root}/audio/transcriptions`;
        const form = new FormData();
        form.append("model", settings.modelId);
        form.append("file", new Blob([synthesisedProbeWav()], { type: "audio/wav" }), "probe.wav");
        pingRequest = { method: "POST", headers, body: form };
      } else {
        pingUrl = `${root}/chat/completions`;
        pingRequest = {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            model: settings.modelId,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            stream: false,
          }),
        };
      }
      const pingResponse = await fetchImpl(pingUrl, pingRequest);
      if (!pingResponse.ok) {
        throw new ProbeHttpError(pingResponse.status, "capability", (await pingResponse.text().catch(() => undefined))?.slice(0, 500));
      }

      // For fish-audio, modelsDiscovered stays null: with no model list the
      // ping cannot independently certify the exact model beyond the header
      // itself, so selectedModelAccepted stays null rather than overclaiming.
      results.push({
        capability,
        status: "validated",
        endpointReachable: true,
        credentialValid: true,
        modelsDiscovered,
        selectedModelAccepted: modelsDiscovered?.includes(settings.modelId) ?? null,
      });
    } catch (error) {
      const failure = await classifyProbeFailure(error);
      results.push({
        capability,
        status: "failed",
        endpointReachable: failure.endpointReachable,
        credentialValid: failure.credentialValid,
        modelsDiscovered: null,
        selectedModelAccepted: null,
        errorCode: failure.errorCode,
        detail: failure.detail,
      });
    }
  }

  const allValidated = results.length > 0 && results.every((result) => result.status === "validated");
  const anyFailed = results.some((result) => result.status === "failed");
  const nextStatus: "unvalidated" | "valid" | "invalid" = allValidated
    ? "valid"
    : anyFailed
      ? "invalid"
      : "unvalidated";
  // A skipped-only probe verifies nothing: leave the stored status untouched.
  if (nextStatus !== "unvalidated" || anyFailed) {
    await save(row.userProviderConfigurationId, nextStatus === "valid" ? "valid" : "invalid", anyFailed);
  }
  return {
    userProviderConfigurationId: row.userProviderConfigurationId,
    providerName: row.providerName,
    credentialStatus: nextStatus,
    capabilities: results,
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * A minimal valid PCM WAV (44-byte RIFF header + a few silent samples) used
 * purely as an ASR connectivity ping. Never derived from real interview or
 * microphone audio.
 */
function synthesisedProbeWav(): ArrayBuffer {
  const sampleCount = 16; // mono, 8 kHz, 8-bit PCM
  const dataLength = sampleCount;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true); // sample rate
  view.setUint32(28, 8000, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  writeText(36, "data");
  view.setUint32(40, dataLength, true);
  for (let index = 0; index < sampleCount; index++) {
    view.setUint8(44 + index, 128); // silence
  }
  return buffer;
}

/**
 * Model-list discovery (FR-PROVIDER-009): retrieves the provider's model IDs
 * for a configuration "when supported" — a missing list endpoint (404/405) is
 * reported as `models: null`, not a failure. Results are cached in memory per
 * configuration identity; the cache is injectable only via the TTL and clock,
 * keeping the shared map process-local.
 */
export interface DiscoveryDeps {
  load?: (userId: string, configurationId: string) => Promise<UserProviderConfiguration | null>;
  fetchImpl?: typeof fetch;
  /** TTL seconds for in-memory model lists (default 60; flagged for review). */
  cacheTtlSeconds?: number;
  now?: () => number;
  /** Cache map (default: a process-local map keyed per configuration). */
  cache?: Map<string, ModelListCacheEntry>;
}

export interface ModelListCacheEntry {
  models: string[] | null;
  expiresAt: number;
}

const DEFAULT_MODEL_LIST_TTL_SECONDS = 60;

export type DiscoveryResult =
  | { ok: true; models: string[] | null; source: "provider" | "cache" }
  | { ok: false; errorCode: ProbeErrorCode; detail: string };

/** Process-lifetime cache; entries expire by TTL and stay keyed per config. */
const MODEL_LIST_CACHE = new Map<string, ModelListCacheEntry>();

/**
 * Shared list-models wire (FR-PROVIDER-009). Presets with a registered
 * override (PRESET_MODEL_LIST_WIRES) speak their documented list endpoint
 * and envelope; everything else speaks the OpenAI shape
 * (`GET {base}/models`, Bearer credential). Returns the discovered IDs,
 * `null` when the provider has no list endpoint (404/405 — "when
 * supported"), and throws ProbeHttpError for any other HTTP failure so the
 * caller classifies it in the probe error taxonomy.
 */
async function fetchModelList(
  normalizedBaseUrl: string,
  apiKey: string,
  presetName: string | null,
  fetchImpl: typeof fetch,
): Promise<string[] | null> {
  const root = stripTrailingSlash(normalizedBaseUrl);
  const wire = presetName ? PRESET_MODEL_LIST_WIRES[presetName] : undefined;

  if (wire && wire.format === "google-v1beta") {
    // Google Generative Language API: resource names arrive as
    // "models/{model_id}" and are stripped to the bare model_id the
    // catalogue stores. nextPageToken is followed, bounded defensively.
    const collected: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const pageUrl = pageToken
        ? `${root}${wire.path}?pageToken=${encodeURIComponent(pageToken)}`
        : `${root}${wire.path}`;
      const response = await fetchImpl(pageUrl, { headers: { "x-goog-api-key": apiKey } });
      if (!response.ok) {
        if (response.status === 404 || response.status === 405) return null;
        throw new ProbeHttpError(
          response.status,
          "models",
          (await response.text().catch(() => undefined))?.slice(0, 500),
        );
      }
      const body = (await response.json()) as {
        models?: Array<{ name?: string }>;
        nextPageToken?: string;
      };
      for (const entry of Array.isArray(body.models) ? body.models : []) {
        const modelId = String(entry.name ?? "").replace(/^models\//, "");
        if (modelId.length > 0) collected.push(modelId);
      }
      pageToken = body.nextPageToken;
      if (!pageToken) break;
    }
    return collected;
  }

  const response = await fetchImpl(`${root}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (response.ok) {
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    return Array.isArray(body.data)
      ? body.data.map((entry) => String(entry.id ?? "")).filter((id) => id.length > 0)
      : null;
  }
  if (response.status === 404 || response.status === 405) {
    // "When supported": a missing list endpoint is not a failure.
    return null;
  }
  throw new ProbeHttpError(
    response.status,
    "models",
    (await response.text().catch(() => undefined))?.slice(0, 500),
  );
}

export async function discoverProviderModels(
  userId: string,
  configurationId: string,
  deps: DiscoveryDeps = {},
): Promise<DiscoveryResult> {
  const load = deps.load ?? loadStoredRow;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const ttlSeconds = deps.cacheTtlSeconds ?? DEFAULT_MODEL_LIST_TTL_SECONDS;
  const cache = deps.cache ?? MODEL_LIST_CACHE;

  const row = await load(userId, configurationId);
  if (!row) {
    throw new ProviderConfigError("not_found", "Provider configuration not found.");
  }

  let baseUrl: string | null = row.baseUrl;
  if (row.providerType === "preset") {
    // Preset rows store no Base URL of their own; resolve the registry
    // default exactly like the probe does, so preset rows are discoverable.
    baseUrl = getPresetAdapter(row.providerName)?.defaultBaseUrl ?? null;
  }

  const cacheKey = `${row.userProviderConfigurationId}|${baseUrl ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now()) {
    return { ok: true, models: cached.models, source: "cache" };
  }

  const urlDecision = evaluateBaseUrl(baseUrl ?? "");
  if (!urlDecision.ok) {
    return {
      ok: false,
      errorCode: "network_unreachable",
      detail: "The configured Base URL is not a usable endpoint.",
    };
  }

  let apiKey: string;
  try {
    apiKey = decryptApiKey(new TextDecoder().decode(row.encryptedApiKey!));
  } catch (error) {
    if (error instanceof ProviderCryptoError) {
      return {
        ok: false,
        errorCode: "authentication_failed",
        detail: "The stored credential could not be decrypted; re-save the configuration.",
      };
    }
    throw error;
  }

  try {
    const models = await fetchModelList(
      urlDecision.normalizedUrl,
      apiKey,
      row.providerType === "preset" ? row.providerName : null,
      fetchImpl,
    );
    cache.set(cacheKey, { models, expiresAt: now() + ttlSeconds * 1000 });
    return { ok: true, models, source: "provider" };
  } catch (error) {
    // Provider connectivity problems surface in the probe error taxonomy, not
    // as an unhandled exception (FR-PROVIDER-006).
    const failure = await classifyProbeFailure(error);
    return { ok: false, errorCode: failure.errorCode, detail: failure.detail };
  }
}

export interface CandidateDiscoveryInput {
  providerType: "preset" | "custom";
  providerName: string;
  /** Required for custom targets; presets always use their registry URL. */
  baseUrl?: string;
  apiKey: string;
}

/**
 * Transient model discovery for pre-create pickers (FR-PROVIDER-009; owner
 * directive 2026-11-16: model setup lists models from the provider's
 * list-models API instead of asking for manual IDs). The target is
 * validated, but nothing is persisted: the credential from the request body
 * is used once for this outbound list call and never stored, cached or
 * logged (write-only credentials, ADR-0005). Target validation failures
 * throw ProviderConfigError (the route maps them to the error envelope);
 * wire failures return the probe taxonomy as a DiscoveryResult.
 */
export async function discoverCandidateModels(
  input: CandidateDiscoveryInput,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<DiscoveryResult> {
  const { normalizedBaseUrl } = validateProviderTarget(input);
  const baseUrl =
    input.providerType === "preset"
      ? getPresetAdapter(input.providerName)?.defaultBaseUrl ?? null
      : normalizedBaseUrl;

  const urlDecision = evaluateBaseUrl(baseUrl ?? "");
  if (!urlDecision.ok) {
    return {
      ok: false,
      errorCode: "network_unreachable",
      detail: "The configured Base URL is not a usable endpoint.",
    };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const models = await fetchModelList(
      urlDecision.normalizedUrl,
      input.apiKey,
      input.providerType === "preset" ? input.providerName : null,
      fetchImpl,
    );
    return { ok: true, models, source: "provider" };
  } catch (error) {
    const failure = await classifyProbeFailure(error);
    return { ok: false, errorCode: failure.errorCode, detail: failure.detail };
  }
}
