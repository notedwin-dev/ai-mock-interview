import { z } from "zod";
import { Prisma, type UserProviderConfiguration } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { decryptApiKey, encryptApiKey } from "./encryption";
// Admin-fixed realtime model IDs are enforced on create and on PATCH (runtime batch).
import { applyRealtimeModelRules } from "./realtime-models";
import { CAPABILITIES, getPresetAdapter, type Capability } from "./registry";
import type { ProviderRoute } from "./provider-route";
import { evaluateBaseUrl } from "./ssrf";

/**
 * Provider configuration service (approved component → module home,
 * docs/ARCHITECTURE.md §3). A row holds one provider's credentials plus the
 * JSONB `capabilities_json` map of the capabilities it serves. The same
 * provider may have one row per capability (e.g. Google for ASR and Google
 * for LLM); a duplicate is only rejected when the SAME capability would be
 * served twice. Runtime exclusivity (realtime vs custom) is high-level only.
 * When names repeat, callers pin the exact row with its configuration id.
 *
 * Write-only credentials (FR-PROVIDER, ADR-0005): the API key is encrypted on
 * save and never read back through this module's output types. The ONLY
 * decryption point is resolveForOutboundCall(), for use immediately before an
 * outbound server call — plaintext is never cached, logged or returned to a
 * client.
 */

const PROVIDER_NAME_MAX = 120; // user_provider_configuration.provider_name VARCHAR(120)
const BASE_URL_MAX = 2048; // user_provider_configuration.base_url VARCHAR(2048)
const MODEL_ID_MAX = 200;
const API_KEY_MAX = 4096;

export const PROVIDER_TYPES = ["preset", "custom"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const CREDENTIAL_STATUSES = ["unvalidated", "valid", "invalid"] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

/** Per-capability settings stored under capabilities_json. */
export const capabilitySettingsSchema = z.object({
  /** Exact provider model ID as selected by the user — never substituted. */
  modelId: z
    .string()
    .trim()
    .min(1, "model_id is required.")
    .max(MODEL_ID_MAX, `model_id must be at most ${MODEL_ID_MAX} characters.`),
});

/** Capability → settings map; at least one capability must be configured. */
export const capabilitiesJsonSchema = z
  .partialRecord(z.enum(CAPABILITIES), capabilitySettingsSchema)
  .refine(
    (value) => Object.keys(value).length >= 1,
    "Configure at least one capability (asr, llm, tts, scorer or realtime).",
  );

export type CapabilitiesJson = z.infer<typeof capabilitiesJsonSchema>;

export const providerConfigInputSchema = z
  .object({
    providerType: z.enum(PROVIDER_TYPES),
    providerName: z
      .string()
      .trim()
      .min(1, "Provider name is required.")
      .max(PROVIDER_NAME_MAX),
    baseUrl: z.string().trim().max(BASE_URL_MAX).optional(),
    apiKey: z.string().trim().min(1).max(API_KEY_MAX).optional(),
    capabilities: capabilitiesJsonSchema,
  })
  .strict();

export type ProviderConfigInput = z.infer<typeof providerConfigInputSchema>;

export const providerConfigPatchSchema = z
  .object({
    baseUrl: z.string().trim().max(BASE_URL_MAX).optional(),
    apiKey: z.string().trim().min(1).max(API_KEY_MAX).optional(),
    capabilities: capabilitiesJsonSchema.optional(),
    isEnabled: z.boolean().optional(),
  })
  .strict();

export type ProviderConfigPatch = z.infer<typeof providerConfigPatchSchema>;

export type ProviderConfigErrorCode =
  | "not_found"
  | "config_exists"
  | "config_ambiguous"
  | "missing_credential"
  | "invalid_base_url"
  | "capability_not_supported"
  | "unknown_preset"
  | "reserved_preset_name"
  | "probe_failed"
  | "invalid_input";

export class ProviderConfigError extends Error {
  readonly code: ProviderConfigErrorCode;

  constructor(code: ProviderConfigErrorCode, message: string) {
    super(message);
    this.name = "ProviderConfigError";
    this.code = code;
  }
}

/**
 * Credential-free view of a configuration row. Deliberately does not include
 * encrypted_api_key / encryption_key_version — those fields must never leave
 * the service (write-only invariant, R-06).
 */
export interface ProviderConfigSummary {
  userProviderConfigurationId: string;
  providerType: ProviderType;
  providerName: string;
  /** Stored (normalised) URL for custom rows; null for presets. */
  baseUrl: string | null;
  capabilities: CapabilitiesJson;
  credentialStatus: CredentialStatus;
  isEnabled: boolean;
  configurationVersion: number;
  updatedAt: string;
}

/**
 * Shared identity/URL validation for a provider target, independent of any
 * capability set (pure — unit-testable). Used by create/update AND by
 * transient model discovery before a row exists: preset names must exist in
 * the registry and may not carry their own Base URL; custom endpoints must
 * not shadow a preset name (user-supplied names are labels, never executable
 * identity) and must carry an SSRF-validated Base URL. Returns the
 * normalised Base URL for custom rows.
 */
export function validateProviderTarget(
  input: Pick<ProviderConfigInput, "providerType" | "providerName" | "baseUrl">,
): { normalizedBaseUrl: string | null } {
  if (input.providerType === "preset") {
    const preset = getPresetAdapter(input.providerName);
    if (!preset) {
      throw new ProviderConfigError(
        "unknown_preset",
        "Unknown preset provider. Pick one of the available presets.",
      );
    }
    if (input.baseUrl !== undefined) {
      throw new ProviderConfigError(
        "invalid_input",
        "Preset providers use their documented Base URL; leave it empty.",
      );
    }
    return { normalizedBaseUrl: null };
  }

  // Custom OpenAI-compatible endpoint.
  if (getPresetAdapter(input.providerName)) {
    throw new ProviderConfigError(
      "reserved_preset_name",
      "This name is reserved by a preset provider; choose a different name for a custom endpoint.",
    );
  }
  if (input.baseUrl === undefined || input.baseUrl === "") {
    throw new ProviderConfigError(
      "invalid_input",
      "A custom endpoint requires a Base URL.",
    );
  }
  const decision = evaluateBaseUrl(input.baseUrl);
  if (!decision.ok) {
    throw new ProviderConfigError(
      "invalid_base_url",
      `Base URL rejected (${decision.reason}).`,
    );
  }
  return { normalizedBaseUrl: decision.normalizedUrl };
}

/**
 * Full rule validation for create and update: target validation above, then
 * the capability check — a preset only serves capabilities it declares.
 */
export function validateProviderRules(
  input: Pick<ProviderConfigInput, "providerType" | "providerName" | "baseUrl" | "capabilities">,
): { normalizedBaseUrl: string | null } {
  const { normalizedBaseUrl } = validateProviderTarget(input);
  if (input.providerType === "preset") {
    const preset = getPresetAdapter(input.providerName)!;
    for (const capability of Object.keys(input.capabilities)) {
      if (!preset.capabilities.includes(capability as Capability)) {
        throw new ProviderConfigError(
          "capability_not_supported",
          `Preset "${preset.displayName}" does not support the ${capability} capability.`,
        );
      }
    }
  }
  return { normalizedBaseUrl };
}

function parseUserId(userId: string): string {
  const parsed = z.uuid().parse(userId);
  if (!parsed) {
    throw new ProviderConfigError("invalid_input", "A valid user is required.");
  }
  return parsed;
}

/**
 * Enablement gate (FR-PROVIDER-006): a failed capability probe marks the
 * stored credential invalid, and a failed test must prevent enabling the
 * capability. Disabling is always allowed; `valid`/`unvalidated` rows may be
 * enabled (the probe is what turns unvalidated into valid).
 */
export function assertEnablementAllowed(
  credentialStatus: "unvalidated" | "valid" | "invalid",
  isEnabled: boolean,
): void {
  if (isEnabled && credentialStatus === "invalid") {
    throw new ProviderConfigError(
      "probe_failed",
      "Fix the failing capability test (re-run the probe) before enabling this configuration.",
    );
  }
}

/** Stable JSON string for comparing JSONB payloads regardless of key order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

const CONFIG_SELECT = {
  userProviderConfigurationId: true,
  userId: false,
  providerType: true,
  providerName: true,
  baseUrl: true,
  capabilitiesJson: true,
  credentialStatus: true,
  isEnabled: true,
  configurationVersion: true,
  updatedAt: true,
} satisfies Partial<Record<keyof UserProviderConfiguration, boolean>>;

type SelectedConfig = {
  userProviderConfigurationId: string;
  providerType: string;
  providerName: string;
  baseUrl: string | null;
  capabilitiesJson: unknown;
  credentialStatus: string;
  isEnabled: boolean;
  configurationVersion: number;
  updatedAt: Date;
};

function toSummary(row: SelectedConfig): ProviderConfigSummary {
  return {
    userProviderConfigurationId: row.userProviderConfigurationId,
    providerType: row.providerType as ProviderType,
    providerName: row.providerName,
    baseUrl: row.baseUrl,
    capabilities: capabilitiesJsonSchema.parse(row.capabilitiesJson),
    credentialStatus: row.credentialStatus as CredentialStatus,
    isEnabled: row.isEnabled,
    configurationVersion: row.configurationVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Only `undefined` means "no id restriction": an empty string is a supplied
 * value and must be rejected, not silently treated as omitted. Validating here
 * keeps every filter/PATCH/probe/DELETE path from bypassing the id restriction
 * or leaking a database error as a 500.
 */
function parseOptionalConfigId(configId?: string): string | undefined {
  if (configId === undefined) return undefined;
  return z.uuid().parse(configId);
}

/**
 * Looks up a row by provider name. When several rows share a name (the same
 * provider may serve several capabilities), configId pins the exact row;
 * otherwise the first row is used for backwards-compatible callers.
 */
/**
 * Serializes the check-then-write for same-name capability exclusivity. A
 * serializable snapshot makes a concurrent conflicting write fail with P2034;
 * bounded retries let the loser re-read and either accept the winner or return
 * config_exists. No lock is held across an await outside the transaction.
 */
async function withSerializableRetry<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const conflict =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
      if (!conflict || attempt >= 2) throw error;
    }
  }
}

async function findOwnedConfig(userId: string, providerName: string, configId?: string) {
  const id = parseOptionalConfigId(configId);
  return db.userProviderConfiguration.findFirst({
    where: {
      userId,
      providerName,
      ...(id !== undefined ? { userProviderConfigurationId: id } : {}),
    },
  });
}

/**
 * Internal accessor for sibling provider modules (the capability probe and
 * model discovery) that need the raw row, including the encrypted key. The
 * return type carries write-only credential material: it must never be
 * serialised into a client response or a log.
 */
export async function findOwnedConfigRow(
  userId: string,
  providerName: string,
  configId?: string,
) {
  return findOwnedConfig(userId, providerName, configId);
}

/* --------------------------- runtime mode ----------------------------------- */

export const RUNTIME_MODES = ["realtime", "custom"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

/** The explicitly chosen runtime; null means a legacy account with no choice yet. */
export async function getActiveRuntimeMode(userId: string): Promise<RuntimeMode | null> {
  const parsedUser = parseUserId(userId);
  const account = await db.userAccount.findUnique({
    where: { userId: parsedUser },
    select: { activeRuntimeMode: true },
  });
  const mode = account?.activeRuntimeMode;
  return mode === "realtime" || mode === "custom" ? mode : null;
}

/**
 * Switching modes never deletes or rewrites saved configurations: it only
 * records which runtime is active. Rows of the other mode stay in the
 * database and are simply ignored for the duration of that mode.
 */
export async function setActiveRuntimeMode(
  userId: string,
  mode: RuntimeMode,
): Promise<void> {
  const parsedUser = parseUserId(userId);
  await db.userAccount.update({
    where: { userId: parsedUser },
    data: { activeRuntimeMode: mode },
  });
}

/**
 * Creates a configuration row for the caller. An API key is mandatory on
 * create (BYOK everywhere, preset or custom); the credential starts
 * `unvalidated` and is proven by the capability probe (TT-20 probing half).
 */
export async function createProviderConfiguration(
  userId: string,
  input: unknown,
): Promise<ProviderConfigSummary> {
  const parsedUser = parseUserId(userId);

  let parsed: ProviderConfigInput;
  try {
    parsed = providerConfigInputSchema.parse(input);
  } catch (error) {
    throw new ProviderConfigError(
      "invalid_input",
      error instanceof Error ? error.message : "Invalid provider configuration.",
    );
  }
  const { normalizedBaseUrl } = validateProviderRules(parsed);

  // Kept from the runtime batch: realtime model IDs are admin-fixed on every
  // write for PRE-CONFIGURED presets (a PATCH must not smuggle in an arbitrary
  // model either). Custom OpenAI-compatible rows keep their exact chosen ID.
  let capabilities = parsed.capabilities;
  if (parsed.providerType === "preset") {
    try {
      capabilities = applyRealtimeModelRules(parsed.capabilities, parsed.providerName);
    } catch {
      throw new ProviderConfigError(
        "invalid_input",
        "This realtime provider is not available for configuration.",
      );
    }
  }
  if (!parsed.apiKey) {
    throw new ProviderConfigError(
      "missing_credential",
      "An API key is required when creating a provider configuration.",
    );
  }

  // Legacy accounts get their first runtime inferred from the row they add,
  // but the inference must be committed with that row: a failed insert must
  // not strand the account in a mode with no usable configuration. Confirm the
  // account exists before this path so a zero-row update cannot be mistaken
  // for a successful inference.
  const account = await db.userAccount.findUnique({
    where: { userId: parsedUser },
    select: { userId: true },
  });
  if (!account) throw new ProviderConfigError("not_found", "Account not found.");
  const inferredMode = capabilities.realtime ? "realtime" : "custom";
  const { envelope, encryptionKeyVersion } = encryptApiKey(parsed.apiKey);

  const created = await withSerializableRetry(async (tx) => {
    // Atomic conditional write: infer the mode only while the account still
    // has none. A concurrent explicit choice between the check and here wins.
    await tx.userAccount.updateMany({
      where: { userId: parsedUser, activeRuntimeMode: null },
      data: { activeRuntimeMode: inferredMode },
    });

    // Runtime exclusivity is high-level only (realtime vs custom). The same
    // provider may be configured again for a DIFFERENT capability; only a row
    // already serving one of the requested capabilities is a duplicate.
    const existingRows = await tx.userProviderConfiguration.findMany({
      where: { userId: parsedUser, providerName: parsed.providerName },
      select: { capabilitiesJson: true },
    });
    const duplicate = existingRows.some((row) => {
      const served = capabilitiesJsonSchema.parse(row.capabilitiesJson);
      return Object.keys(capabilities).some((capability) => capability in served);
    });
    if (duplicate) {
      throw new ProviderConfigError(
        "config_exists",
        `"${parsed.providerName}" is already configured for this capability. Update that configuration instead.`,
      );
    }

    return tx.userProviderConfiguration.create({
      data: {
        userId: parsedUser,
        providerType: parsed.providerType,
        providerName: parsed.providerName,
        baseUrl: normalizedBaseUrl,
        // TextEncoder (not Buffer.from): the generated Bytes type is
        // Uint8Array, and driver adapters deliver/expect raw byte views.
        encryptedApiKey: new TextEncoder().encode(envelope),
        encryptionKeyVersion,
        capabilitiesJson: capabilities,
        credentialStatus: "unvalidated",
      },
    });
  });
  return toSummary(created);
}

/**
 * Updates an owned configuration. A new apiKey re-encrypts under the active
 * key version; any material change (Base URL, key, capability settings)
 * resets credential_status to `unvalidated` — approved rule: retest on
 * configuration change. An isEnabled toggle alone never invalidates the
 * credential.
 */
export async function updateProviderConfiguration(
  userId: string,
  providerName: string,
  patch: unknown,
  configId?: string,
): Promise<ProviderConfigSummary> {
  const parsedUser = parseUserId(userId);

  let parsed: ProviderConfigPatch;
  try {
    parsed = providerConfigPatchSchema.parse(patch);
  } catch (error) {
    throw new ProviderConfigError(
      "invalid_input",
      error instanceof Error ? error.message : "Invalid provider configuration patch.",
    );
  }

  const row = await findOwnedConfig(parsedUser, providerName, configId);
  if (!row) {
    throw new ProviderConfigError("not_found", "Provider configuration not found.");
  }

  const currentCapabilities = capabilitiesJsonSchema.parse(row.capabilitiesJson);
  const data: {
    baseUrl?: string | null;
    // runtime.Bytes is ReturnType<Uint8Array["slice"]> = Uint8Array<ArrayBuffer>.
    encryptedApiKey?: Uint8Array<ArrayBuffer>;
    encryptionKeyVersion?: string;
    capabilitiesJson?: CapabilitiesJson;
    credentialStatus?: CredentialStatus;
    isEnabled?: boolean;
    configurationVersion: { increment: number };
  } = {
    configurationVersion: { increment: 1 },
  };

  let materialChange = false;

  if (parsed.capabilities !== undefined) {
    const nextType = row.providerType as ProviderType;
    // Admin-fixed realtime models apply on EVERY write to PRE-CONFIGURED
    // presets; custom rows keep their exact model id.
    let capabilities: CapabilitiesJson = parsed.capabilities;
    if (nextType === "preset") {
      try {
        capabilities = applyRealtimeModelRules(
          parsed.capabilities,
          row.providerName,
        ) as CapabilitiesJson;
      } catch {
        throw new ProviderConfigError(
          "invalid_input",
          "This realtime provider is not available for configuration.",
        );
      }
    }
    const rules = validateProviderRules({
      providerType: nextType,
      providerName: row.providerName,
      baseUrl: nextType === "custom" ? (parsed.baseUrl ?? row.baseUrl ?? undefined) : undefined,
      capabilities,
    });
    if (nextType === "custom" && parsed.baseUrl !== undefined) {
      data.baseUrl = rules.normalizedBaseUrl;
    }
    if (stableStringify(currentCapabilities) !== stableStringify(capabilities)) {
      // The sibling check is performed atomically with the write below.
      data.capabilitiesJson = capabilities;
      materialChange = true;
    }
  } else if (parsed.baseUrl !== undefined) {
    // Base URL change without touching capabilities.
    if (row.providerType !== "custom") {
      throw new ProviderConfigError(
        "invalid_input",
        "Preset providers use their documented Base URL; leave it empty.",
      );
    }
    const decision = evaluateBaseUrl(parsed.baseUrl);
    if (!decision.ok) {
      throw new ProviderConfigError(
        "invalid_base_url",
        `Base URL rejected (${decision.reason}).`,
      );
    }
    if (decision.normalizedUrl !== row.baseUrl) {
      data.baseUrl = decision.normalizedUrl;
      materialChange = true;
    }
  }

  if (parsed.apiKey !== undefined) {
    const { envelope, encryptionKeyVersion } = encryptApiKey(parsed.apiKey);
    data.encryptedApiKey = new TextEncoder().encode(envelope);
    data.encryptionKeyVersion = encryptionKeyVersion;
    materialChange = true;
  }

  if (materialChange) {
    data.credentialStatus = "unvalidated";
  }

  // Enablement gate (FR-PROVIDER-006) runs on the EFFECTIVE status: a patch
  // that also fixes the credential (material change) resets the status to
  // unvalidated, so a previously failed probe no longer blocks enabling.
  const effectiveStatus = materialChange
    ? ("unvalidated" as const)
    : (row.credentialStatus as "unvalidated" | "valid" | "invalid");
  if (parsed.isEnabled !== undefined && parsed.isEnabled !== row.isEnabled) {
    assertEnablementAllowed(effectiveStatus, parsed.isEnabled);
    data.isEnabled = parsed.isEnabled;
  }

  const updated = await withSerializableRetry(async (tx) => {
    if (data.capabilitiesJson !== undefined) {
      // Same invariant as creation, checked inside the same serializable
      // transaction as the write: a concurrent conflicting PATCH must lose
      // with config_exists rather than create a duplicate capability route.
      const siblings = await tx.userProviderConfiguration.findMany({
        where: {
          userId: parsedUser,
          providerName: row.providerName,
          NOT: { userProviderConfigurationId: row.userProviderConfigurationId },
        },
        select: { capabilitiesJson: true },
      });
      const overlap = siblings.some((sibling) => {
        const served = capabilitiesJsonSchema.parse(sibling.capabilitiesJson);
        return Object.keys(data.capabilitiesJson!).some((capability) => capability in served);
      });
      if (overlap) {
        throw new ProviderConfigError(
          "config_exists",
          `"${row.providerName}" is already configured for one of these capabilities. Update that configuration instead.`,
        );
      }
    }
    return tx.userProviderConfiguration.update({
      where: { userProviderConfigurationId: row.userProviderConfigurationId },
      data,
      select: CONFIG_SELECT,
    });
  });
  return toSummary(updated);
}

/** Credential-free listing of the caller's configurations. */
export async function listProviderConfigurations(
  userId: string,
): Promise<ProviderConfigSummary[]> {
  const parsedUser = parseUserId(userId);
  const rows = await db.userProviderConfiguration.findMany({
    where: { userId: parsedUser },
    select: CONFIG_SELECT,
    // Most recently changed first: after a mode switch the newest matching
    // configuration is the one the runtime should prefer.
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(toSummary);
}

/**
 * Resolves an enabled configuration that serves the given capability, and —
 * only here, only for the outbound call — decrypts the stored credential
 * (ADR-0005). The returned plaintext must be handed straight to the provider
 * adapter; never cached, logged or returned to a client.
 */
export async function resolveForOutboundCall(
  userId: string,
  capability: Capability,
): Promise<ProviderRoute> {
  const parsedUser = parseUserId(userId);
  if (!CAPABILITIES.includes(capability)) {
    throw new ProviderConfigError("invalid_input", "Unknown capability.");
  }

  // Deterministic when several enabled configurations serve the same
  // capability: a validated connection wins over an unvalidated/dummy row,
  // then the most recently updated wins within the same status, so switching
  // modes picks up the latest configuration the candidate saved. Our earlier
  // "oldest wins" rule is superseded by the active-mode migration.
  const activeMode = await getActiveRuntimeMode(parsedUser);
  const rows = await db.userProviderConfiguration.findMany({
    where: { userId: parsedUser, isEnabled: true },
    // Latest configuration first; a validated connection still wins below.
    orderBy: { updatedAt: "desc" },
  });
  const serving = rows.filter((candidate) => {
    const caps = capabilitiesJsonSchema.parse(candidate.capabilitiesJson);
    if (!(capability in caps)) return false;
    // Scoring gates reports, not an interview runtime, so its configured row
    // stays resolvable in either mode.
    if (capability === "scorer") return true;
    // A realtime route is only usable in realtime mode. A mixed row still
    // serves its custom routes below; it is never a realtime route in custom.
    if (capability === "realtime") return activeMode !== "custom" && Boolean(caps.realtime);
    if (activeMode === "realtime") return Boolean(caps.realtime);
    if (activeMode === "custom") {
      // A mixed row still serves its non-realtime routes in custom mode.
      return !caps.realtime || Object.keys(caps).some((key) => key !== "realtime");
    }
    return true;
  });
  // Owner decision: realtime never falls back to an unvalidated credential.
  const row =
    capability === "realtime"
      ? (serving.find((candidate) => candidate.credentialStatus === "valid") ?? null)
      : (serving.find((candidate) => candidate.credentialStatus === "valid") ?? serving[0]);
  if (!row) {
    throw new ProviderConfigError(
      "not_found",
      `No enabled provider configuration serves the ${capability} capability.`,
    );
  }

  let baseUrl: string;
  if (row.providerType === "custom") {
    if (!row.baseUrl) {
      // Guarded by the DB CHECK; fail closed rather than call anywhere.
      throw new ProviderConfigError("invalid_base_url", "Custom configuration has no Base URL.");
    }
    baseUrl = row.baseUrl;
  } else {
    const preset = getPresetAdapter(row.providerName);
    if (!preset) {
      // Registry drift vs stored data — fail closed, never guess an endpoint.
      throw new ProviderConfigError(
        "unknown_preset",
        `Preset "${row.providerName}" is no longer registered.`,
      );
    }
    baseUrl = preset.defaultBaseUrl;
  }

  const capabilities = capabilitiesJsonSchema.parse(row.capabilitiesJson);
  const modelId = capabilities[capability]?.modelId;
  if (!modelId) {
    throw new ProviderConfigError(
      "not_found",
      `The configuration does not define a model for the ${capability} capability.`,
    );
  }

  const envelopeBytes = row.encryptedApiKey;
  if (!envelopeBytes || !row.encryptionKeyVersion) {
    throw new ProviderConfigError(
      "missing_credential",
      "The configuration has no stored credential.",
    );
  }

  return {
    providerName: row.providerName,
    providerType: row.providerType as ProviderType,
    baseUrl,
    modelId,
    // Prisma 7 driver adapters deliver Bytes as Uint8Array (no Buffer
    // toString encodings); decode explicitly to the envelope string.
    apiKey: decryptApiKey(new TextDecoder().decode(envelopeBytes)),
  };
}

/**
 * Credential-free resolution of the enabled provider + model for a
 * capability (ADR-0005). For the case where the server must know WHICH
 * provider model the candidate has enabled without making an outbound call
 * (e.g. rendering the live-voice room page, which shows the model id):
 * resolves the oldest enabled row serving the capability and returns
 * only the provider name and model id. It never reads or decrypts
 * `encrypted_api_key` (write-only invariant), and the result is not an
 * authorization to call the provider.
 *
 * Fails closed with `ProviderConfigError` when no enabled row serves the
 * capability or the capability has no configured model — callers must
 * explain the situation to the user (the room page surfaces the reason and
 * how to fix it); they never fail silently.
 */
export async function resolveEnabledModel(
  userId: string,
  capability: Capability,
): Promise<{ providerName: string; modelId: string }> {
  const parsedUser = parseUserId(userId);
  if (!CAPABILITIES.includes(capability)) {
    throw new ProviderConfigError("invalid_input", "Unknown capability.");
  }

  const rows = await db.userProviderConfiguration.findMany({
    where: { userId: parsedUser, isEnabled: true },
    orderBy: { createdAt: "asc" },
    // Credential-free resolution: never read (let alone decrypt) the key.
    select: { providerType: true, providerName: true, capabilitiesJson: true },
  });
  const row = rows.find(
    (candidate) => capability in capabilitiesJsonSchema.parse(candidate.capabilitiesJson),
  );
  if (!row) {
    throw new ProviderConfigError(
      "not_found",
      `No enabled provider configuration serves the ${capability} capability.`,
    );
  }
  if (row.providerType === "preset" && !getPresetAdapter(row.providerName)) {
    // Registry drift vs stored data — fail closed, same as the outbound path.
    throw new ProviderConfigError(
      "unknown_preset",
      `Preset "${row.providerName}" is no longer registered.`,
    );
  }

  const capabilities = capabilitiesJsonSchema.parse(row.capabilitiesJson);
  const modelId = capabilities[capability]?.modelId;
  if (!modelId) {
    throw new ProviderConfigError(
      "not_found",
      `The configuration does not define a model for the ${capability} capability.`,
    );
  }
  return { providerName: row.providerName, modelId };
}

/** Deletes an owned configuration row (credentials destroyed with it). */
export async function deleteProviderConfiguration(
  userId: string,
  providerName: string,
  configId?: string,
): Promise<void> {
  const parsedUser = parseUserId(userId);
  const id = parseOptionalConfigId(configId);
  if (id !== undefined) {
    const result = await db.userProviderConfiguration.deleteMany({
      where: { userId: parsedUser, providerName, userProviderConfigurationId: id },
    });
    if (result.count === 0) {
      throw new ProviderConfigError("not_found", "Provider configuration not found.");
    }
    return;
  }

  // Name-only deletion is retained for a single row. Several rows of the same
  // name are legal (one per capability), so deleting all of them by name would
  // be destructive; require an explicit id instead.
  const matches = await db.userProviderConfiguration.findMany({
    where: { userId: parsedUser, providerName },
    select: { userProviderConfigurationId: true },
  });
  if (matches.length === 0) {
    throw new ProviderConfigError("not_found", "Provider configuration not found.");
  }
  if (matches.length > 1) {
    throw new ProviderConfigError(
      "config_ambiguous",
      `Multiple "${providerName}" configurations exist. Specify a configuration id to delete one.`,
    );
  }
  await db.userProviderConfiguration.deleteMany({
    where: {
      userId: parsedUser,
      providerName,
      userProviderConfigurationId: matches[0]!.userProviderConfigurationId,
    },
  });
}
