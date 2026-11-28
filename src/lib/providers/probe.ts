import type { UserProviderConfiguration } from "@/generated/prisma/client";
import { db } from "@/lib/db";
// Reintroduced from the runtime batch: the realtime capability probe uses a
// short-lived native session token (never interview content) to prove the key.
import {
  createRealtimeToken,
  RealtimeTokenError,
  type LiveSessionConfig,
} from "@/lib/interview/realtime-token";
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
 * Probe wire shapes:
 * - `openai` and every custom row speak the OpenAI-compatible wire
 *   (`GET /models`, `POST /chat/completions`, `POST /audio/speech`,
 *   `POST /audio/transcriptions`). A custom row whose Base URL points at
 *   `fish.audio` is probed on Fish's native TTS wire instead, matching the
 *   runtime TTS adapter (same URL test).
 * - `fish-audio` speaks its native TTS wire (`POST /v1/tts`, model selected
 *   by a request header).
 * - `google` speaks its native Gemini wire: ASR and TTS go through
 *   `POST /v1beta/interactions` with `x-goog-api-key` (the same resource
 *   shape the runtime ASR adapter uses); LLM/scorer run on the
 *   OpenAI-compatible surface at `{base}/v1beta/openai/chat/completions`
 *   with Bearer auth (verified against the official OpenAI-compatibility
 *   docs, 2026-11-25). The model list keeps the native
 *   `GET /v1beta/models` override.
 * - `anthropic` speaks its native Messages wire: LLM/scorer go through
 *   `POST /v1/messages` with `x-api-key` + `anthropic-version`; it has no
 *   model-list endpoint (404/405 there is "when supported", not a failure).
 * - `elevenlabs` speaks its native wire: TTS is
 *   `POST /v1/text-to-speech/{voice_id}` (model ID in the `model_id` body)
 *   and ASR is `POST
 *   /v1/speech-to-text`, both with `xi-api-key`; it has no model-list
 *   endpoint.
 *
 * Native realtime sessions (the `realtime` capability: Gemini Live, OpenAI
 * Realtime) negotiate the provider's own protocol and are verified through
 * the realtime session-token path above — a non-Gemini realtime
 * configuration is reported skipped until its native runtime lands. Model-list
 * discovery (FR-PROVIDER-009) lives in the same module and shares the wire
 * handling: presets without an override use `GET {base}/models` (Bearer);
 * registry overrides (Google: `GET /v1beta/models` with `x-goog-api-key`)
 * are honoured by both stored-row and candidate discovery. DNS-rebinding/redirect
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
   * `configurationVersion` is the version read when the probe started: the
   * write is conditioned on it so a replacement configuration is untouched.
   * `disable` is true exactly when the probe failed — a failed test must
   * prevent the capability being (or remaining) enabled (FR-PROVIDER-006).
   */
  save?: (
    configurationId: string,
    credentialStatus: "valid" | "invalid",
    disable: boolean,
    configurationVersion: number,
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
  configurationVersion: number,
): Promise<void> {
  return db.userProviderConfiguration
    .update({
      // Version-conditioned: a row replaced or edited during this probe is
      // never stamped with a result produced with its old credential/model.
      where: { userProviderConfigurationId: configurationId, configurationVersion },
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
 * Native realtime token failures are typed (RealtimeTokenError). Classify them
 * by `errorCode`/`status` first so a "rate-limited" 429 or an auth rejection is
 * not misread by the message-only fallback below. That fallback stays for
 * provider SDK errors whose only signal is an embedded HTTP response. No
 * credential material is ever echoed.
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
  if (error instanceof RealtimeTokenError) {
    const endpointReachable = error.status !== undefined;
    switch (error.errorCode) {
      case "authentication_failed":
        return {
          errorCode: "authentication_failed",
          detail: "The provider rejected the API key.",
          endpointReachable,
        };
      case "rate_limited":
        return {
          errorCode: "rate_limited",
          detail: "The provider rate-limited the realtime session request.",
          endpointReachable,
        };
      case "unsupported_provider":
        // No provider request was made — the wire is not implemented.
        return { errorCode: "model_unsupported", detail: error.detail, endpointReachable: false };
      case "provider_error":
      default:
        return { errorCode: "provider_error", detail: error.detail, endpointReachable };
    }
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
 * Presets the probe can verify natively: every approved preset has a
 * documented wire the probe speaks (see the capability ping below) — the
 * OpenAI-compatible shape for `openai`/`deepseek`/`zai-glm`/`qwen`, the
 * native Gemini wire for `google`, the native Messages wire for `anthropic`,
 * the native `xi-api-key` wires for `elevenlabs` and the native TTS wire for
 * `fish-audio`. No preset is silently "validated" on a wire that is not
 * actually exercised: a capability without a verified wire for a preset
 * stays on its native wire or fails closed.
 */
const PROBEABLE_PRESETS = new Set<string>([
  "openai",
  "anthropic",
  "google",
  "elevenlabs",
  "fish-audio",
  "deepseek",
  "zai-glm",
  "qwen",
]);

/**
 * Fish-shaped URL test — byte-for-byte the runtime TTS adapter's check
 * (src/lib/ai/tts.ts): a custom row whose Base URL points at `fish.audio`
 * must be probed on the same native TTS wire the runtime uses, not on an
 * OpenAI-shaped endpoint the runtime would never hit.
 */
const FISH_AUDIO_URL_RE = /^https?:\/\/(?:[^/]*\.)?fish\.audio(?:[/:]|$)/i;

/**
 * Canonical provider hosts used by the runtime adapters (llm.ts, tts.ts,
 * asr.ts): a custom row whose Base URL points at one of these hosts speaks the
 * provider's native wire, whatever the row is named. Other custom hosts keep
 * the generic OpenAI-compatible handling.
 */
const ELEVENLABS_API_HOST = "api.elevenlabs.io";
const ANTHROPIC_API_HOST = "api.anthropic.com";

function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The ElevenLabs TTS URL path segment is a VOICE id, not a model id — the
 * exact configured model id stays in the `model_id` body field. This is the
 * premade voice from the documented text-to-speech example: a catalogue
 * constant, not a user-selected voice or a model substitution.
 */
const ELEVENLABS_PROBE_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

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

  const configurationVersion = row.configurationVersion;
  const capabilities = capabilitiesJsonSchema.parse(row.capabilitiesJson);
  const results: CapabilityProbeResult[] = [];

  // Fish-shaped rows speak a native wire instead of OpenAI-compatible
  // endpoints (same URL test as the runtime TTS adapter), and they have no
  // OpenAI-shaped model list (`GET /model` lists community voices, not TTS
  // models) — so no model list is ever consumed.
  const effectiveBaseUrl =
    row.providerType === "preset"
      ? getPresetAdapter(row.providerName)?.defaultBaseUrl ?? null
      : row.baseUrl;
  const customBaseUrl = row.providerType === "custom" ? row.baseUrl : null;
  const isFishAudioPreset =
    (row.providerType === "preset" && row.providerName === "fish-audio") ||
    (customBaseUrl !== null && FISH_AUDIO_URL_RE.test(customBaseUrl));
  // Native-wire selection matches the runtime adapters: preset name OR the
  // canonical host on a custom row (which may be named something else).
  const isElevenLabsWire =
    (row.providerType === "preset" && row.providerName === "elevenlabs") ||
    (row.providerType === "custom" && hostOf(customBaseUrl) === ELEVENLABS_API_HOST);
  const isAnthropicWire =
    (row.providerType === "preset" && row.providerName === "anthropic") ||
    (row.providerType === "custom" && hostOf(customBaseUrl) === ANTHROPIC_API_HOST);

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
      // Gemini Live and ElevenLabs Realtime both mint server-side short-lived
      // session secrets over their own native wire; both can be validated here.
      const isElevenLabsRealtime =
        row.providerName === "elevenlabs" &&
        (row.providerType === "preset" || realtimeBase.includes("api.elevenlabs.io"));
      const isNativeRealtime =
        Boolean(deps.realtimeToken) ||
        row.providerName === "google" ||
        isElevenLabsRealtime ||
        realtimeBase.includes("generativelanguage.googleapis.com");
      if (!isNativeRealtime) {
        results.push({
          capability,
          status: "skipped",
          endpointReachable: false,
          credentialValid: false,
          modelsDiscovered: null,
          selectedModelAccepted: null,
          // Both fixes: name the verified wires and stay status-neutral —
          // no chat wire is contacted and no interview content is sent.
          detail: "Realtime verification is available for Gemini Live and ElevenLabs configurations only; this test does not contact the chat wires.",
        });
        continue;
      }
      try {
        const apiKey = decryptApiKey(new TextDecoder().decode(row.encryptedApiKey!));
        // The live token API needs a neutral session config (no interview
        // content). The real minter also receives the probe's injected fetch
        // so ElevenLabs' native client-secret mint stays hermetic in tests.
        const probeInstructions = "Connectivity probe only — no interview content is sent.";
        const route = {
          providerName: row.providerName,
          providerType: row.providerType as "custom" | "preset",
          baseUrl: realtimeBase,
          modelId: settings.modelId,
          apiKey,
        };
        const session = deps.realtimeToken
          ? await deps.realtimeToken(route, {
              instructions: probeInstructions,
              sessionConfig: { instructions: probeInstructions },
            })
          : await createRealtimeToken(
              route,
              {
                instructions: probeInstructions,
                sessionConfig: { instructions: probeInstructions },
              },
              { fetchImpl },
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

    // Base URL: custom rows carry their own; presets resolve via the
    // registry. A preset without a probeable wire stays skipped — never
    // silently "validated".
    const baseUrl = effectiveBaseUrl;
    if (
      row.providerType === "preset" &&
      !PROBEABLE_PRESETS.has(row.providerName)
    ) {
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
      // (404/405) returns null and is not a capability failure. Fish-shaped
      // rows (`GET /model` lists community voices, not TTS models) and
      // ElevenLabs have no such endpoint, so nothing is requested for them.
      let modelsDiscovered: string[] | null = null;
      if (!isFishAudioPreset && !isElevenLabsWire) {
        modelsDiscovered = await fetchModelList(
          urlDecision.normalizedUrl,
          apiKey,
          row.providerType === "preset" ? row.providerName : null,
          fetchImpl,
        );
      }

      // Step 2: capability-specific ping with no real interview content.
      // Each capability gets its own endpoint and wire shape on the wire the
      // RUNTIME uses for this row — the probe must never validate a
      // configuration through an endpoint the runtime would not hit. The
      // LLM-shaped ping (chat/completions) serves llm and scorer.
      const root = stripTrailingSlash(urlDecision.normalizedUrl);
      const isGooglePreset = row.providerType === "preset" && row.providerName === "google";
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
        } else if (isGooglePreset) {
          // Native Gemini TTS: the Interactions API with the audio output
          // format (POST /v1beta/interactions, x-goog-api-key). The exact
          // configured model id is preserved; the prebuilt voice is the
          // probe's only styling choice (the registry's TTS models are
          // text-in/audio-out and accept `speech_config`).
          pingUrl = `${root}/v1beta/interactions`;
          pingRequest = {
            method: "POST",
            headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
            body: JSON.stringify({
              model: settings.modelId,
              input: [{ type: "user_input", content: [{ type: "text", text: "ping" }] }],
              response_format: { type: "audio" },
              generation_config: { speech_config: [{ voice: "Kore" }] },
            }),
          };
        } else if (isElevenLabsWire) {
          // Native ElevenLabs TTS: the documented URL path segment is the
          // voice ID (a premade catalogue voice), while the exact configured
          // model ID travels in `model_id` in the body — never substituted.
          // Audio bytes in the 2xx response prove the model can synthesise.
          pingUrl = `${root}/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_PROBE_VOICE_ID)}`;
          pingRequest = {
            method: "POST",
            headers: { "xi-api-key": apiKey, "content-type": "application/json" },
            body: JSON.stringify({
              text: "ping",
              model_id: settings.modelId,
              voice_settings: { stability: 0.5, similarity_boost: 0.75, use_speaker_boost: true },
            }),
          };
        } else {
          // OpenAI-compatible TTS (the `openai` preset and every non-fish
          // custom row).
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
        if (isGooglePreset) {
          // Native Gemini ASR: the Interactions API with inline audio — the
          // exact wire (and `models/<id>` resource shape) the runtime ASR
          // adapter uses. The synthesised probe WAV never comes from a real
          // interview or microphone.
          const wavBytes = new Uint8Array(synthesisedProbeWav());
          pingUrl = `${root}/v1beta/interactions`;
          pingRequest = {
            method: "POST",
            headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
            body: JSON.stringify({
              model: settings.modelId.startsWith("models/")
                ? settings.modelId
                : `models/${settings.modelId}`,
              input: [
                { type: "audio", data: Buffer.from(wavBytes).toString("base64"), mime_type: "audio/wav" },
              ],
            }),
          };
        } else if (isElevenLabsWire) {
          // Native ElevenLabs ASR (Scribe): multipart model_id + the
          // synthesised probe WAV.
          pingUrl = `${root}/v1/speech-to-text`;
          const form = new FormData();
          form.append("model_id", settings.modelId);
          // ElevenLabs Scribe's documented multipart field is `file`
          // (the runtime ASR adapter sends the same field).
          form.append(
            "file",
            new Blob([synthesisedProbeWav()], { type: "audio/wav" }),
            "probe.wav",
          );
          pingRequest = { method: "POST", headers: { "xi-api-key": apiKey }, body: form };
        } else {
          pingUrl = `${root}/audio/transcriptions`;
          const form = new FormData();
          form.append("model", settings.modelId);
          form.append("file", new Blob([synthesisedProbeWav()], { type: "audio/wav" }), "probe.wav");
          pingRequest = { method: "POST", headers, body: form };
        }
      } else if (isAnthropicWire) {
        // Native Anthropic Messages wire: `x-api-key` + the fixed API
        // version; model, max_tokens and messages match the documented
        // request shape. It has no model-list endpoint — step 1 ran against
        // `GET {base}/models` and a 404/405 there is "when supported".
        pingUrl = `${root}/v1/messages`;
        pingRequest = {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: settings.modelId,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          }),
        };
      } else {
        // LLM/scorer ping. Google resolves to its OpenAI-compatible surface
        // (`/v1beta/openai/...`) — the documented base for OpenAI-shaped
        // calls, where Bearer auth is the documented credential form.
        const openAiRoot = isGooglePreset ? `${root}/v1beta/openai` : root;
        pingUrl = `${openAiRoot}/chat/completions`;
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

      // For fish-shaped rows and ElevenLabs, modelsDiscovered stays null:
      // with no model list the ping cannot independently certify the exact
      // model beyond the wire itself, so selectedModelAccepted stays null
      // rather than overclaiming.
      results.push({
        capability,
        status: "validated",
        endpointReachable: true,
        credentialValid: true,
        modelsDiscovered,
        selectedModelAccepted: modelsDiscovered?.includes(settings.modelId) ?? null,
      });
    } catch (error) {
      let failure = await classifyProbeFailure(error);
      if (
        isAnthropicWire &&
        error instanceof ProbeHttpError &&
        error.stage === "capability" &&
        error.status === 404
      ) {
        // Anthropic's Messages endpoint always exists: a 404 on
        // POST /v1/messages is an unknown/unsupported model, not a missing
        // endpoint (the request had already been authenticated to reach
        // model routing). FR-PROVIDER-006 taxonomy: model_unsupported.
        failure = {
          errorCode: "model_unsupported",
          detail: "The provider rejected the selected model for this capability.",
          endpointReachable: true,
          credentialValid: true,
        };
      }
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
  // Row-level validity requires every capability on the row to be validated:
  // a realtime success alone must not mark an untested LLM route as valid.
  const nextStatus: "unvalidated" | "valid" | "invalid" = allValidated
    ? "valid"
    : anyFailed
      ? "invalid"
      : "unvalidated";
  const disable = anyFailed;
  // A skipped-only probe verifies nothing: leave the stored status untouched.
  if (nextStatus !== "unvalidated" || disable) {
    try {
      await save(
        row.userProviderConfigurationId,
        nextStatus === "valid" ? "valid" : "invalid",
        disable,
        configurationVersion,
      );
    } catch {
      throw new ProviderConfigError(
        "probe_failed",
        "This configuration changed while it was being tested. Test the current configuration again.",
      );
    }
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
 * A minimal valid PCM WAV (44-byte RIFF header + silent samples) used purely
 * as an ASR connectivity ping. Never derived from real interview or
 * microphone audio. ElevenLabs Scribe requires at least 100 ms of audio, so
 * keep the synthetic clip comfortably above that floor.
 */
function synthesisedProbeWav(): ArrayBuffer {
  // 8 kHz × 8-bit mono: 800 samples = 100 ms; use 200 ms to clear the limit.
  const sampleCount = 1600;
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
