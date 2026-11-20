"use client";

import { useMemo, useState } from "react";
import {
  AudioLines,
  Brain,
  Check,
  ClipboardCheck,
  Loader2,
  Mic,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Capability, ModelSuggestion } from "@/lib/providers/registry";
import { PRESET_ADAPTERS, PRESET_MODEL_SUGGESTIONS } from "@/lib/providers/registry";
import type { ProviderConfigSummary } from "@/lib/providers/config";
import type {
  CapabilityProbeResult,
  ConfigurationProbeResult,
  DiscoveryResult,
} from "@/lib/providers/probe";

/**
 * AI configuration experience (FR-PROVIDER-001..009; ADR-028/029/030; owner
 * mockup + directive, 2026-11-16). The page mirrors the approved runtime
 * architecture (ADR-006) with two mutually exclusive interview runtime
 * options:
 *
 *  - Option 1 — Pre-configured Realtime Agents ("Native integrations"):
 *    Gemini Live / OpenAI Realtime run the whole interview as one native
 *    realtime session; users don't configure separate ASR, LLM and TTS
 *    models in this mode. One row per provider: when a row for the provider
 *    already exists, adding realtime PATCHes the capability onto it.
 *  - Option 2 — Custom Configuration ("Composable pipeline"): ASR/STT, LLM,
 *    TTS and the evaluation scorer, each with pre-configured provider chips
 *    and its own Custom OpenAI-compatible option (own Base URL, API key and
 *    exact model_id). Nothing is inherited or substituted across
 *    capabilities; the scorer is configured independently of the
 *    interviewer LLM (FR-PROVIDER-003).
 *
 * Which option runs an interview is chosen at interview creation, not here.
 *
 * Model setup is list-driven (owner directive 2026-11-16): every form waits
 * for the API key, then loads the provider's model list and the user picks
 * an exact ID — no manual typing by default. Pre-create forms use transient
 * discovery (POST /api/v1/providers/discover-models, key used once, never
 * stored); stored rows use the per-row endpoint with the stored key. When a
 * provider exposes no list endpoint, the approved catalogue offers the
 * choices; only a custom endpoint with neither falls back to manual entry.
 *
 * Wire-only invariants preserved here: credentials are write-only (sent to
 * the API, never displayed or stored in client state beyond a password
 * field), model IDs are always the exact provider strings, and a failed test
 * is reported honestly — never smoothed over.
 */

const CAPABILITY_SECTIONS = [
  {
    capability: "asr",
    title: "ASR / STT",
    role: "Speech recognition provider and model.",
    Icon: Mic,
  },
  {
    capability: "llm",
    title: "LLM",
    role: "Interview conversation, question generation and follow-ups.",
    Icon: Brain,
  },
  {
    capability: "tts",
    title: "TTS",
    role: "Interviewer speech synthesis provider and model.",
    Icon: AudioLines,
  },
  {
    capability: "scorer",
    title: "Scorer",
    role: "Scores completed interviews separately from the interviewer model.",
    Icon: ClipboardCheck,
  },
] as const satisfies ReadonlyArray<{
  capability: Capability;
  title: string;
  role: string;
  Icon: LucideIcon;
}>;

const CAPABILITY_LABELS: Record<Capability, string> = {
  asr: "ASR",
  llm: "LLM",
  tts: "TTS",
  scorer: "Scorer",
  realtime: "Realtime",
};

const CREDENTIAL_STATUS: Record<
  string,
  { word: string; dot: string; text: string; hint: string }
> = {
  valid: {
    word: "Validated",
    dot: "bg-emerald-400",
    text: "text-emerald-400",
    hint: "A capability test passed for this configuration.",
  },
  unvalidated: {
    word: "Not validated yet",
    dot: "bg-amber-400",
    text: "text-amber-300",
    hint: "Run a capability test to prove this configuration works.",
  },
  invalid: {
    word: "Check failed",
    dot: "bg-red-400",
    text: "text-red-400",
    hint: "Fix the failing test result, then re-test before enabling.",
  },
};

const FIELD_CLASS =
  "h-11 w-full rounded-full border border-transparent bg-raised px-5 text-sm text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-emerald-400/70 focus:ring-2 focus:ring-emerald-400/20";
const LABEL_CLASS = "text-xs font-medium uppercase tracking-wide text-ink-muted";
const PRIMARY_PILL =
  "inline-flex h-10 cursor-pointer items-center gap-2 rounded-full bg-emerald-400 px-5 text-sm font-semibold text-emerald-950 outline-none transition-all hover:bg-emerald-300 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-emerald-400";
const GHOST_PILL =
  "inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-line bg-transparent px-4 text-sm font-medium text-ink-soft outline-none transition-colors hover:border-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER_PILL =
  "inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-red-400/40 bg-transparent px-4 text-sm font-medium text-red-300 outline-none transition-colors hover:border-red-400 hover:text-red-200 focus-visible:ring-2 focus-visible:ring-red-400/50 disabled:cursor-not-allowed disabled:opacity-50";

type ApiError = { code: string; message: string };

async function callApi<T>(
  input: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
  try {
    const response = await fetch(input, init);
    const text = await response.text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    if (!response.ok) {
      const error = (body as { error?: ApiError } | null)?.error;
      return {
        ok: false,
        error: error ?? { code: "internal_error", message: "Something went wrong. Try again." },
      };
    }
    return { ok: true, data: body as T };
  } catch {
    return {
      ok: false,
      error: { code: "network_error", message: "The request could not reach the server." },
    };
  }
}

/**
 * Raw per-row discovery outcome (stored-key discovery). Forms resolve it
 * into picker state together with the capability's catalogue fallback.
 */
interface RowModelList {
  state: "loading" | "done";
  result: DiscoveryResult | null;
}

/**
 * Picker state resolved from a discovery outcome (owner directive
 * 2026-11-16: model setup waits for the API key, then lists the provider's
 * models and the user picks — typing an ID is the honest last resort, never
 * the default). Priority: live discovery → approved catalogue fallback →
 * manual entry when neither exists.
 */
interface ModelListState {
  state: "idle" | "loading" | "ready" | "failed";
  models: string[];
  /** Where the picker options came from, when ready. */
  source: "discovery" | "catalogue" | null;
  note?: string;
}

const IDLE_MODEL_LIST: ModelListState = { state: "idle", models: [], source: null };

function resolveModelList(
  raw: RowModelList,
  catalogue: readonly ModelSuggestion[],
): ModelListState {
  if (raw.state === "loading") return { state: "loading", models: [], source: null };
  const result = raw.result;
  if (result === null) return IDLE_MODEL_LIST;
  const catalogueIds = catalogue.map((s) => s.modelId);
  if (result.ok) {
    if (result.models && result.models.length > 0) {
      return { state: "ready", models: result.models, source: "discovery" };
    }
    if (catalogueIds.length > 0) {
      return {
        state: "ready",
        models: catalogueIds,
        source: "catalogue",
        note: "This provider exposes no model list — the choices below come from the approved model catalogue; verify the exact ID in your provider console.",
      };
    }
    return {
      state: "failed",
      models: [],
      source: null,
      note: "This provider exposes no model list — enter the exact model ID from your provider console.",
    };
  }
  if (catalogueIds.length > 0) {
    return {
      state: "ready",
      models: catalogueIds,
      source: "catalogue",
      note: `${result.detail} Choices below come from the approved model catalogue; verify the exact ID in your provider console.`,
    };
  }
  return { state: "failed", models: [], source: null, note: result.detail };
}

function suggestionsFor(
  capability: Capability,
  providerName: string | null,
): readonly ModelSuggestion[] {
  if (!providerName) return [];
  // Scorer is an LLM-shaped call; reuse the preset's LLM suggestions.
  const source = capability === "scorer" ? "llm" : capability;
  return PRESET_MODEL_SUGGESTIONS[providerName]?.[source] ?? [];
}

function friendlyProviderName(row: ProviderConfigSummary): string {
  if (row.providerType === "preset") {
    return PRESET_ADAPTERS.find((p) => p.providerName === row.providerName)?.displayName ?? row.providerName;
  }
  return row.providerName;
}

interface ProviderConfiguratorProps {
  initialConfigurations: ProviderConfigSummary[];
}

export function ProviderConfigurator({ initialConfigurations }: ProviderConfiguratorProps) {
  const [rows, setRows] = useState<ProviderConfigSummary[]>(initialConfigurations);
  const [modelsByRow, setModelsByRow] = useState<Record<string, RowModelList>>({});
  const [probeByRow, setProbeByRow] = useState<Record<string, ConfigurationProbeResult>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Record<string, ApiError>>({});
  const [collapsed, setCollapsed] = useState<Record<Capability, boolean>>({
    asr: true,
    llm: false,
    tts: true,
    scorer: true,
    realtime: true,
  });

  async function refresh(): Promise<ProviderConfigSummary[]> {
    const result = await callApi<{ configurations: ProviderConfigSummary[] }>(
      "/api/v1/providers/configurations",
      { cache: "no-store" },
    );
    if (result.ok) {
      setRows(result.data.configurations);
      return result.data.configurations;
    }
    return [];
  }

  async function runAction(
    key: string,
    action: () => Promise<ApiError | null>,
  ): Promise<ApiError | null> {
    setPending(key);
    setActionError((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    const error = await action();
    setPending(null);
    if (error) setActionError((current) => ({ ...current, [key]: error }));
    return error;
  }

  function clearRowState(rowId: string) {
    setProbeByRow((current) => {
      const next = { ...current };
      delete next[rowId];
      return next;
    });
    setModelsByRow((current) => {
      const next = { ...current };
      delete next[rowId];
      return next;
    });
  }

  async function findModels(row: ProviderConfigSummary) {
    const rowId = row.userProviderConfigurationId;
    // GET …/models runs the list-models wire with the STORED key and answers
    // with the DiscoveryResult union: ok:true with the model IDs (null when
    // the provider has no list endpoint), or ok:false with the probe error
    // taxonomy. The row card resolves the outcome together with the
    // capability's catalogue fallback — a failed discovery never fabricates
    // a model list.
    setModelsByRow((current) => ({
      ...current,
      [rowId]: { state: "loading", result: null },
    }));
    await runAction(`${rowId}:models`, async () => {
      const response = await callApi<DiscoveryResult>(
        `/api/v1/providers/configurations/${encodeURIComponent(row.providerName)}/models`,
        { cache: "no-store" },
      );
      const result: DiscoveryResult = response.ok
        ? response.data
        : { ok: false, errorCode: "provider_error", detail: response.error.message };
      setModelsByRow((current) => ({
        ...current,
        [rowId]: { state: "done", result },
      }));
      return null;
    });
  }

  async function runProbe(row: ProviderConfigSummary) {
    const key = `${row.userProviderConfigurationId}:probe`;
    await runAction(key, async () => {
      const result = await callApi<ConfigurationProbeResult>(
        `/api/v1/providers/configurations/${encodeURIComponent(row.providerName)}/probe`,
        { method: "POST" },
      );
      if (!result.ok) return result.error;
      setProbeByRow((current) => ({
        ...current,
        [row.userProviderConfigurationId]: result.data,
      }));
      // The probe writes the stored credential status (and disables the row
      // on failure server-side) — re-sync the summary list.
      await refresh();
      return null;
    });
  }

  async function patchRow(
    row: ProviderConfigSummary,
    patch: Record<string, unknown>,
    key: string,
  ): Promise<boolean> {
    const error = await runAction(key, async () => {
      const result = await callApi<{ configuration: ProviderConfigSummary }>(
        `/api/v1/providers/configurations/${encodeURIComponent(row.providerName)}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) },
      );
      if (!result.ok) return result.error;
      setRows((current) =>
        current.map((candidate) =>
          candidate.userProviderConfigurationId === result.data.configuration.userProviderConfigurationId
            ? result.data.configuration
            : candidate,
        ),
      );
      return null;
    });
    return error === null;
  }

  async function deleteRow(row: ProviderConfigSummary) {
    // Confirmation is the in-row two-step control; no extra browser dialog.
    const key = `${row.userProviderConfigurationId}:delete`;
    const error = await runAction(key, async () => {
      const response = await fetch(
        `/api/v1/providers/configurations/${encodeURIComponent(row.providerName)}`,
        { method: "DELETE" },
      );
      if (!response.ok && response.status !== 204) {
        const body = (await response.json().catch(() => null)) as { error?: ApiError } | null;
        return body?.error ?? { code: "internal_error", message: "Delete failed." };
      }
      setRows((current) =>
        current.filter(
          (candidate) =>
            candidate.userProviderConfigurationId !== row.userProviderConfigurationId,
        ),
      );
      clearRowState(row.userProviderConfigurationId);
      return null;
    });
    if (error === null) await refresh();
  }

  /**
   * Option 1 add flow (one row per provider): without an existing row the
   * provider configuration is created with only the realtime capability;
   * with one, the realtime capability is PATCHed onto the stored row and the
   * existing credential stays untouched (an apiKey-less patch never
   * re-encrypts). Model IDs are never invented: the form takes the exact ID
   * and discovery loads the account's list after saving.
   */
  async function addRealtime(
    providerName: string,
    apiKey: string | null,
    modelId: string,
  ): Promise<boolean> {
    const key = `realtime:${providerName}`;
    const existing = rows.find(
      (row) => row.providerType === "preset" && row.providerName === providerName,
    );
    const error = await runAction(key, async () => {
      if (existing) {
        if (existing.capabilities.realtime) return null;
        const result = await callApi<{ configuration: ProviderConfigSummary }>(
          `/api/v1/providers/configurations/${encodeURIComponent(providerName)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              capabilities: { ...existing.capabilities, realtime: { modelId } },
            }),
          },
        );
        if (!result.ok) return result.error;
        setRows((current) =>
          current.map((candidate) =>
            candidate.userProviderConfigurationId ===
            result.data.configuration.userProviderConfigurationId
              ? result.data.configuration
              : candidate,
          ),
        );
        return null;
      }
      const result = await callApi<{ configuration: ProviderConfigSummary }>(
        "/api/v1/providers/configurations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerType: "preset",
            providerName,
            apiKey: apiKey ?? "",
            capabilities: { realtime: { modelId } },
          }),
        },
      );
      if (!result.ok) return result.error;
      await refresh();
      return null;
    });
    return error === null;
  }

  return (
    <div className="flex flex-col gap-6">
      <ReadinessStrip rows={rows} onJump={(capability) => setCollapsed((c) => ({ ...c, [capability]: false }))} />

      <RealtimeOptionCard
        rows={rows}
        modelsByRow={modelsByRow}
        probeByRow={probeByRow}
        pending={pending}
        actionError={actionError}
        onFindModels={findModels}
        onProbe={runProbe}
        onPatch={patchRow}
        onDelete={deleteRow}
        onAddRealtime={addRealtime}
      />

      <section
        aria-labelledby="custom-config-heading"
        className="overflow-hidden rounded-3xl border border-line bg-surface"
      >
        <OptionCardHeader
          id="custom-config-heading"
          title="Custom Configuration"
          badge="Composable pipeline"
          subtitle="Compose the interview pipeline from independently configured capabilities."
        />
        <div className="border-t border-line">
          {CAPABILITY_SECTIONS.map((section) => (
            <CapabilitySection
              key={section.capability}
              section={section}
              rows={rows}
              collapsed={collapsed[section.capability]}
              onToggle={() =>
                setCollapsed((c) => ({ ...c, [section.capability]: !c[section.capability] }))
              }
              modelsByRow={modelsByRow}
              probeByRow={probeByRow}
              pending={pending}
              actionError={actionError}
              onFindModels={findModels}
              onProbe={runProbe}
              onPatch={patchRow}
              onDelete={deleteRow}
              onCreated={async () => {
                await refresh();
              }}
            />
          ))}
          <p className="px-5 pb-5 text-xs text-ink-muted sm:px-6">
            Users independently select providers and models for each capability.
          </p>
        </div>
      </section>
    </div>
  );
}

/* ---------------------------------- readiness ---------------------------------- */

function readinessFor(rows: ProviderConfigSummary[], capability: Capability) {
  const serving = rows.filter((row) => row.capabilities[capability]);
  const enabled = serving.find((row) => row.isEnabled) ?? null;
  if (serving.length === 0) {
    return { state: "empty" as const, label: "Not set up", dot: "bg-ink-muted/60", text: "text-ink-muted", names: "" };
  }
  if (!enabled) {
    return { state: "disabled" as const, label: "Configured, disabled", dot: "bg-ink-muted/60", text: "text-ink-muted", names: friendlyProviderName(serving[0]!) };
  }
  const status = CREDENTIAL_STATUS[enabled.credentialStatus] ?? CREDENTIAL_STATUS.unvalidated!;
  return {
    state: enabled.credentialStatus as "valid" | "unvalidated" | "invalid",
    label: status.word,
    dot: status.dot,
    text: status.text,
    names: friendlyProviderName(enabled),
  };
}

function ReadinessStrip({
  rows,
  onJump,
}: {
  rows: ProviderConfigSummary[];
  onJump: (capability: Capability) => void;
}) {
  return (
    <section aria-label="Capability readiness" className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 lg:gap-3">
        {CAPABILITY_SECTIONS.map(({ capability, title, Icon }) => {
          const readiness = readinessFor(rows, capability);
          return (
            <li key={capability}>
              <button
                type="button"
                onClick={() => onJump(capability)}
                className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1.5 text-left outline-none transition-colors hover:bg-raised focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-raised text-ink-soft">
                  <Icon className="h-4 w-4" aria-hidden />
                  <span
                    aria-hidden
                    className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface ${readiness.dot}`}
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="text-sm font-medium text-ink">{title}</span>
                  <span className={`mt-0.5 truncate text-xs ${readiness.text}`}>
                    {readiness.names ? `${readiness.names} — ${readiness.label}` : readiness.label}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ----------------------- option 1: realtime agents -------------------------- */

/**
 * Register Option A ("Pre-configured Realtime Agents", ADR-006): native
 * realtime sessions that replace the composed ASR/LLM/TTS pipeline. Only the
 * two provider-native presets are offered; the realtime model ID comes from
 * the user (discovery + manual entry) because the owner-maintained catalogue
 * lists no realtime agent model IDs yet.
 */
const REALTIME_OPTIONS = [
  {
    providerName: "google",
    optionTitle: "Gemini Live",
    monogram: "G",
    blurb: "Native realtime voice session on the Gemini Live API.",
  },
  {
    providerName: "openai",
    optionTitle: "OpenAI Realtime",
    monogram: "OA",
    blurb: "Native realtime voice session on the OpenAI Realtime API.",
  },
] as const satisfies ReadonlyArray<{
  providerName: string;
  optionTitle: string;
  monogram: string;
  blurb: string;
}>;

/** Subtle monogram tiles — clean initials, no trademark artwork. */
const MONOGRAM_TILE: Record<string, string> = {
  google: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  openai: "border-line bg-raised text-ink-soft",
};

function MonogramTile({ providerName, monogram }: { providerName: string; monogram: string }) {
  return (
    <span
      aria-hidden
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border text-sm font-bold tracking-wide ${MONOGRAM_TILE[providerName] ?? "border-line bg-raised text-ink-soft"}`}
    >
      {monogram}
    </span>
  );
}

function OptionCardHeader({
  id,
  title,
  badge,
  subtitle,
}: {
  id: string;
  title: string;
  badge: string;
  subtitle: string;
}) {
  return (
    <div className="flex flex-col gap-2 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="font-display text-lg font-semibold tracking-tight text-ink">
          {title}
        </h2>
        <span className="rounded-full border border-line bg-raised px-2.5 py-1 text-xs font-medium text-ink-muted">
          {badge}
        </span>
      </div>
      <p className="text-sm text-ink-muted">{subtitle}</p>
    </div>
  );
}

interface RealtimeOptionCardProps {
  rows: ProviderConfigSummary[];
  modelsByRow: Record<string, RowModelList>;
  probeByRow: Record<string, ConfigurationProbeResult>;
  pending: string | null;
  actionError: Record<string, ApiError>;
  onFindModels: (row: ProviderConfigSummary) => void;
  onProbe: (row: ProviderConfigSummary) => void;
  onPatch: (
    row: ProviderConfigSummary,
    patch: Record<string, unknown>,
    key: string,
  ) => Promise<boolean>;
  onDelete: (row: ProviderConfigSummary) => void;
  onAddRealtime: (
    providerName: string,
    apiKey: string | null,
    modelId: string,
  ) => Promise<boolean>;
}

function RealtimeOptionCard(props: RealtimeOptionCardProps) {
  const [formOpenFor, setFormOpenFor] = useState<string | null>(null);
  return (
    <section
      aria-labelledby="realtime-agents-heading"
      className="overflow-hidden rounded-3xl border border-line bg-surface"
    >
      <OptionCardHeader
        id="realtime-agents-heading"
        title="Pre-configured Realtime Agents"
        badge="Native integrations"
        subtitle="Runs the whole interview as one native realtime session — users don't configure separate ASR, LLM and TTS models in this mode."
      />
      <div className="divide-y divide-line border-t border-line">
        {REALTIME_OPTIONS.map((option) => (
          <NativeRealtimeBlock
            key={option.providerName}
            option={option}
            formOpen={formOpenFor === option.providerName}
            onToggleForm={() =>
              setFormOpenFor((current) =>
                current === option.providerName ? null : option.providerName,
              )
            }
            {...props}
          />
        ))}
      </div>
    </section>
  );
}

type NativeRealtimeOption = (typeof REALTIME_OPTIONS)[number];

/**
 * One provider block: monogram card header (status + action) and, when
 * configured, the realtime row with the same row-card treatment as Option 2.
 * Without a stored row the block offers create (API key + model); with one
 * missing only the realtime capability it offers the PATCH flow.
 */
function NativeRealtimeBlock({
  option,
  formOpen,
  onToggleForm,
  rows,
  modelsByRow,
  probeByRow,
  pending,
  actionError,
  onFindModels,
  onProbe,
  onPatch,
  onDelete,
  onAddRealtime,
}: RealtimeOptionCardProps & {
  option: NativeRealtimeOption;
  formOpen: boolean;
  onToggleForm: () => void;
}) {
  const row =
    rows.find(
      (candidate) =>
        candidate.providerType === "preset" && candidate.providerName === option.providerName,
    ) ?? null;
  const realtime = row?.capabilities.realtime ?? null;
  const formKey = `realtime:${option.providerName}`;
  // PATCH path: the stored-key model list lives here so it can load when the
  // form OPENS (a click handler, not a mount effect) without ever seeing the
  // stored credential.
  const [storedList, setStoredList] = useState<ModelListState>(IDLE_MODEL_LIST);

  async function loadStoredModels(): Promise<ModelListState> {
    setStoredList({ state: "loading", models: [], source: null });
    const response = await callApi<DiscoveryResult>(
      `/api/v1/providers/configurations/${encodeURIComponent(option.providerName)}/models`,
      { cache: "no-store" },
    );
    const raw: RowModelList = {
      state: "done",
      result: response.ok
        ? response.data
        : { ok: false, errorCode: "provider_error", detail: response.error.message },
    };
    const resolved = resolveModelList(raw, []);
    setStoredList(resolved);
    return resolved;
  }

  const status = !row
    ? { text: "Not set up", cls: "text-ink-muted", dot: "bg-ink-muted/60" }
    : realtime
      ? (() => {
          const credential = CREDENTIAL_STATUS[row.credentialStatus] ?? CREDENTIAL_STATUS.unvalidated!;
          return {
            text: `${credential.word} · ${row.isEnabled ? "enabled" : "disabled"}`,
            cls: credential.text,
            dot: credential.dot,
          };
        })()
    : { text: "Configured — realtime capability not added yet", cls: "text-amber-300", dot: "bg-amber-400" };

  return (
    <article className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <MonogramTile providerName={option.providerName} monogram={option.monogram} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">{option.optionTitle}</p>
            <p className="mt-0.5 text-sm text-ink-muted">{option.blurb}</p>
            <span className={`mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium ${status.cls}`}>
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
              {status.text}
            </span>
          </div>
        </div>
        {!row ? (
          <button type="button" onClick={onToggleForm} disabled={pending !== null} className={PRIMARY_PILL}>
            <Plus className="h-4 w-4" aria-hidden />
            Set up
          </button>
        ) : !realtime ? (
          <button
            type="button"
            onClick={() => {
              onToggleForm();
              void loadStoredModels();
            }}
            disabled={pending !== null}
            className={GHOST_PILL}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add realtime
          </button>
        ) : null}
      </div>

      {formOpen ? (
        <RealtimeAddForm
          option={option}
          needsKey={!row}
          formKey={formKey}
          pending={pending}
          actionError={actionError}
          storedList={storedList}
          onReloadStored={loadStoredModels}
          onSubmit={(apiKey, modelId) => onAddRealtime(option.providerName, apiKey, modelId)}
          onCancel={onToggleForm}
        />
      ) : null}

      {row && realtime ? (
        <div className="mt-4">
          <ConfigurationRowCard
            row={row}
            capability="realtime"
            modelsByRow={modelsByRow}
            probeByRow={probeByRow}
            pending={pending}
            actionError={actionError}
            onFindModels={onFindModels}
            onProbe={onProbe}
            onPatch={onPatch}
            onDelete={onDelete}
          />
        </div>
      ) : null}
    </article>
  );
}

function RealtimeAddForm({
  option,
  needsKey,
  formKey,
  pending,
  actionError,
  storedList,
  onReloadStored,
  onSubmit,
  onCancel,
}: {
  option: NativeRealtimeOption;
  needsKey: boolean;
  formKey: string;
  pending: string | null;
  actionError: Record<string, ApiError>;
  /** PATCH path: the block owns the stored-key list state (loaded on open). */
  storedList: ModelListState;
  onReloadStored: () => Promise<ModelListState>;
  onSubmit: (apiKey: string | null, modelId: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [typedList, setTypedList] = useState<ModelListState>(IDLE_MODEL_LIST);
  const list = needsKey ? typedList : storedList;

  // Owner directive 2026-11-16: the form never asks for a model ID — it lists
  // the provider's models and the user picks one. Both native realtime
  // presets expose a model-list endpoint, so there is no manual fallback:
  // create loads through the transient discovery endpoint with the typed key;
  // the PATCH path (credential already stored) loads through the stored-row
  // endpoint without ever seeing the key.
  async function loadList(): Promise<ModelListState> {
    if (!needsKey) return onReloadStored();
    const trimmed = apiKey.trim();
    if (!trimmed) return IDLE_MODEL_LIST;
    setTypedList({ state: "loading", models: [], source: null });
    const response = await callApi<DiscoveryResult>("/api/v1/providers/discover-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerType: "preset",
        providerName: option.providerName,
        apiKey: trimmed,
      }),
    });
    const raw: RowModelList = {
      state: "done",
      result: response.ok
        ? response.data
        : { ok: false, errorCode: "provider_error", detail: response.error.message },
    };
    const resolved = resolveModelList(raw, []);
    setTypedList(resolved);
    return resolved;
  }

  async function submit() {
    setError(null);
    if (needsKey && !apiKey.trim()) {
      setError({ code: "missing_credential", message: "An API key is required." });
      return;
    }
    let current = list;
    if (current.state !== "ready") {
      current = await loadList();
    }
    if (current.state !== "ready") {
      setError({ code: "invalid_input", message: "Load the model list first, then select a model." });
      return;
    }
    if (!modelId) {
      setError({ code: "invalid_input", message: "Select a model from the list." });
      return;
    }
    const ok = await onSubmit(needsKey ? apiKey.trim() : null, modelId);
    if (ok) onCancel();
  }

  return (
    <form
      className="mt-4 flex flex-col gap-4 rounded-2xl border border-emerald-400/40 bg-raised/40 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink">
          {needsKey ? `Set up ${option.optionTitle}` : `Add realtime to ${option.optionTitle}`}
        </span>
        <button type="button" onClick={onCancel} disabled={pending !== null} className={GHOST_PILL}>
          Cancel
        </button>
      </div>
      {needsKey ? (
        <label className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setTypedList(IDLE_MODEL_LIST);
            }}
            onBlur={() => {
              if (list.state === "idle" || list.state === "failed") void loadList();
            }}
            className={`${FIELD_CLASS} font-mono`}
            placeholder="Paste the provider API key"
            autoComplete="off"
            maxLength={4096}
          />
          <span className="text-xs text-ink-muted">
            The provider&apos;s model list loads automatically once the key is entered.
          </span>
        </label>
      ) : (
        <p className="rounded-xl bg-surface px-4 py-2.5 text-xs text-ink-muted">
          {option.optionTitle} is already configured — this adds the realtime capability to
          that configuration and keeps the stored API key.
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        <span className={LABEL_CLASS}>Model</span>
        {list.state === "ready" ? (
          <select
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            className={FIELD_CLASS}
            aria-label={`Model for ${option.optionTitle}`}
          >
            <option value="" disabled>
              Select a model…
            </option>
            {list.models.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        ) : (
          <div className="flex h-11 items-center gap-2 rounded-full bg-raised px-5 text-sm text-ink-muted">
            {list.state === "loading" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Loading the model list…
              </>
            ) : list.state === "failed" ? (
              "The model list could not be loaded."
            ) : (
              "The provider's model list appears here once the API key is entered."
            )}
          </div>
        )}
        {list.state === "ready" && list.source === "discovery" ? (
          <span className="text-xs text-ink-muted">
            {list.models.length} models loaded from the provider&apos;s list — pick the
            realtime model your account exposes.
          </span>
        ) : null}
        {list.note ? <span className="text-xs text-amber-300">{list.note}</span> : null}
        {list.state === "failed" ? (
          <span>
            <button
              type="button"
              onClick={() => void loadList()}
              disabled={pending !== null}
              className={GHOST_PILL}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Load models
            </button>
          </span>
        ) : null}
      </div>
      {error ? <p className="text-xs text-red-400">{error.message}</p> : null}
      {actionError[formKey] ? (
        <p className="text-xs text-red-400">{actionError[formKey]!.message}</p>
      ) : null}
      <div>
        <button type="submit" disabled={pending !== null} className={PRIMARY_PILL}>
          {pending === formKey ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
          {needsKey ? "Create configuration" : "Add realtime capability"}
        </button>
      </div>
    </form>
  );
}

/* --------------------------------- section ---------------------------------- */

type SectionMeta = (typeof CAPABILITY_SECTIONS)[number];

interface CapabilitySectionProps {
  section: SectionMeta;
  rows: ProviderConfigSummary[];
  collapsed: boolean;
  onToggle: () => void;
  modelsByRow: Record<string, RowModelList>;
  probeByRow: Record<string, ConfigurationProbeResult>;
  pending: string | null;
  actionError: Record<string, ApiError>;
  onFindModels: (row: ProviderConfigSummary) => void;
  onProbe: (row: ProviderConfigSummary) => void;
  onPatch: (
    row: ProviderConfigSummary,
    patch: Record<string, unknown>,
    key: string,
  ) => Promise<boolean>;
  onDelete: (row: ProviderConfigSummary) => void;
  onCreated: (created: ProviderConfigSummary) => void;
}

function CapabilitySection(props: CapabilitySectionProps) {
  const { section, rows, collapsed, onToggle } = props;
  const serving = useMemo(
    () => rows.filter((row) => row.capabilities[section.capability]),
    [rows, section.capability],
  );
  const readiness = readinessFor(rows, section.capability);

  return (
    <section
      id={`capability-${section.capability}`}
      className="border-b border-line"
      aria-labelledby={`${section.capability}-heading`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex w-full cursor-pointer items-center gap-4 p-5 text-left outline-none transition-colors hover:bg-raised/40 focus-visible:ring-2 focus-visible:ring-emerald-400 sm:p-6"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line bg-raised text-ink-soft">
          <section.Icon className="h-5 w-5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span id={`${section.capability}-heading`} className="font-display text-lg font-semibold tracking-tight text-ink">
              {section.title}
            </span>
            <span className={`flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-xs font-medium ${readiness.text}`}>
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${readiness.dot}`} />
              {readiness.names ? `${readiness.names} · ${readiness.label}` : readiness.label}
            </span>
          </span>
          <span className="mt-1 block text-sm text-ink-muted">{section.role}</span>
        </span>
        <span aria-hidden className={`shrink-0 text-ink-muted transition-transform ${collapsed ? "" : "rotate-180"}`}>
          ▾
        </span>
      </button>

      {!collapsed ? (
        <div className="flex flex-col gap-4 border-t border-line p-5 sm:p-6">
          {serving.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line bg-surface/50 px-4 py-3 text-sm text-ink-muted">
              No configuration serves this capability yet. Add a pre-configured
              provider or a custom OpenAI-compatible endpoint below.
            </p>
          ) : (
            serving.map((row) => (
              <ConfigurationRowCard
                key={row.userProviderConfigurationId}
                row={row}
                capability={section.capability}
                modelsByRow={props.modelsByRow}
                probeByRow={props.probeByRow}
                pending={props.pending}
                actionError={props.actionError}
                onFindModels={props.onFindModels}
                onProbe={props.onProbe}
                onPatch={props.onPatch}
                onDelete={props.onDelete}
              />
            ))
          )}
          <AddProviderArea capability={section.capability} onCreated={props.onCreated} />
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------- row detail --------------------------------- */

interface ConfigurationRowCardProps extends Omit<CapabilitySectionProps, "section" | "rows" | "collapsed" | "onToggle" | "onCreated"> {
  row: ProviderConfigSummary;
  capability: Capability;
}

function ConfigurationRowCard({
  row,
  capability,
  modelsByRow,
  probeByRow,
  pending,
  actionError,
  onFindModels,
  onProbe,
  onPatch,
  onDelete,
}: ConfigurationRowCardProps) {
  const rowId = row.userProviderConfigurationId;
  const servingCapability = row.capabilities[capability];
  const [editingModel, setEditingModel] = useState(false);
  const [modelDraft, setModelDraft] = useState(servingCapability?.modelId ?? "");
  const [editingKey, setEditingKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const credentials = CREDENTIAL_STATUS[row.credentialStatus] ?? CREDENTIAL_STATUS.unvalidated!;
  const suggestions = suggestionsFor(capability, row.providerType === "preset" ? row.providerName : null);
  // The editor always opens with a fresh list load ("Change" triggers
  // discovery), so an absent entry renders as loading until it lands.
  const rawList = modelsByRow[rowId] ?? { state: "loading" as const, result: null };
  const list = resolveModelList(rawList, suggestions);
  const probe = probeByRow[rowId];
  const probeForCapability = probe?.capabilities.find((r) => r.capability === capability);
  const noteById = new Map(suggestions.map((s) => [s.modelId, s.note] as const));
  // Manual entry is the honest last resort: a custom endpoint whose gateway
  // exposes no model list and has no catalogue. Presets always have one of
  // the two, so they never ask the user to type an ID.
  const allowManual = row.providerType === "custom" && list.state === "failed";
  const savedModelId = servingCapability?.modelId ?? "";

  const modelBusy = pending === `${rowId}:model` || rawList.state === "loading";

  return (
    <article className="rounded-2xl border border-line bg-raised/40 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="rounded-full border border-line bg-surface px-3 py-1 text-sm font-medium text-ink">
            {friendlyProviderName(row)}
          </span>
          <span className="rounded-full bg-surface px-2.5 py-1 text-xs text-ink-muted">
            {row.providerType === "preset" ? "Pre-configured provider" : "Custom OpenAI-compatible"}
          </span>
          {row.baseUrl ? (
            <span className="max-w-full truncate rounded-full bg-surface px-2.5 py-1 text-xs text-ink-muted">
              {row.baseUrl}
            </span>
          ) : null}
        </div>
        <span className={`flex shrink-0 items-center gap-1.5 text-xs font-medium ${credentials.text}`} title={credentials.hint}>
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${credentials.dot}`} />
          {credentials.word}
        </span>
      </div>

      {/* Model */}
      <div className="mt-4">
        <span className={LABEL_CLASS}>Model ({CAPABILITY_LABELS[capability]})</span>
        {!editingModel ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <code className="rounded-full bg-surface px-3 py-1.5 text-sm text-ink">
              {savedModelId}
            </code>
            <button
              type="button"
              onClick={() => {
                setModelDraft(savedModelId);
                setEditingModel(true);
                onFindModels(row);
              }}
              disabled={pending !== null}
              className={GHOST_PILL}
            >
              Change
            </button>
          </div>
        ) : (
          <form
            className="mt-1.5 flex flex-col gap-2"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!modelDraft.trim()) return;
              const nextCapabilities = { ...row.capabilities, [capability]: { modelId: modelDraft.trim() } };
              const ok = await onPatch(row, { capabilities: nextCapabilities }, `${rowId}:model`);
              if (ok) setEditingModel(false);
            }}
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              {list.state === "ready" ? (
                <select
                  value={modelDraft}
                  onChange={(event) => setModelDraft(event.target.value)}
                  className={FIELD_CLASS}
                  aria-label={`Model for ${CAPABILITY_LABELS[capability]}`}
                >
                  <option value="" disabled>
                    Select a model…
                  </option>
                  {savedModelId && !list.models.includes(savedModelId) ? (
                    <option value={savedModelId}>{savedModelId} (currently saved)</option>
                  ) : null}
                  {list.models.map((id) => (
                    <option key={id} value={id}>
                      {noteById.get(id) ? `${id} (${noteById.get(id)})` : id}
                    </option>
                  ))}
                </select>
              ) : allowManual ? (
                <input
                  value={modelDraft}
                  onChange={(event) => setModelDraft(event.target.value)}
                  className={FIELD_CLASS}
                  placeholder="Exact provider model ID"
                  aria-label={`Model ID for ${CAPABILITY_LABELS[capability]}`}
                  maxLength={200}
                />
              ) : (
                <div className="flex h-11 items-center gap-2 rounded-full bg-raised px-5 text-sm text-ink-muted">
                  {list.state === "loading" ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      Loading the model list…
                    </>
                  ) : (
                    "The model list is not loaded yet."
                  )}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={modelBusy || pending !== null || (list.state === "ready" && !modelDraft)}
                  className={PRIMARY_PILL}
                >
                  {modelBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
                  Save model
                </button>
                <button type="button" onClick={() => setEditingModel(false)} className={GHOST_PILL}>
                  Cancel
                </button>
              </div>
            </div>
            {list.state === "ready" && list.source === "discovery" ? (
              <p className="text-xs text-ink-muted">
                {list.models.length} models loaded from the provider&apos;s list.
                {list.models.includes(savedModelId) ? " The saved model is in the list." : ""}
              </p>
            ) : null}
            {list.note ? <p className="text-xs text-amber-300">{list.note}</p> : null}
            {list.state === "failed" ? (
              <div>
                <button
                  type="button"
                  onClick={() => onFindModels(row)}
                  disabled={modelBusy || pending !== null}
                  className={GHOST_PILL}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Load models
                </button>
              </div>
            ) : null}
            {actionError[`${rowId}:model`] ? (
              <p className="text-xs text-red-400">{actionError[`${rowId}:model`]!.message}</p>
            ) : null}
          </form>
        )}
      </div>

      {/* Credential */}
      <div className="mt-3">
        <span className={LABEL_CLASS}>API key</span>
        {!editingKey ? (
          <div className="mt-1.5 flex items-center gap-3">
            <span className="text-sm text-ink-soft">Stored — write-only, never shown again.</span>
            <button type="button" onClick={() => { setKeyDraft(""); setEditingKey(true); }} className={GHOST_PILL}>
              Replace key
            </button>
          </div>
        ) : (
          <form
            className="mt-1.5 flex flex-col gap-2 sm:flex-row"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!keyDraft.trim()) return;
              const ok = await onPatch(row, { apiKey: keyDraft.trim() }, `${rowId}:key`);
              if (ok) { setEditingKey(false); setKeyDraft(""); }
            }}
          >
            <input
              type="password"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              className={`${FIELD_CLASS} font-mono`}
              placeholder="Paste the new API key"
              aria-label="New API key"
              autoComplete="off"
              maxLength={4096}
            />
            <div className="flex gap-2">
              <button type="submit" disabled={pending !== null} className={PRIMARY_PILL}>
                Save key
              </button>
              <button type="button" onClick={() => setEditingKey(false)} className={GHOST_PILL}>
                Cancel
              </button>
            </div>
            {actionError[`${rowId}:key`] ? (
              <p className="text-xs text-red-400">{actionError[`${rowId}:key`]!.message}</p>
            ) : null}
          </form>
        )}
      </div>

      {/* Probe result */}
      {probe ? (
        <div className="mt-4 rounded-xl border border-line bg-surface p-3">
          <span className={LABEL_CLASS}>Last test result</span>
          <ProbeResultView result={probeForCapability ?? null} fullResult={probe} capability={capability} />
        </div>
      ) : null}

      {/* Actions */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onProbe(row)}
          disabled={pending !== null}
          className={GHOST_PILL}
        >
          {pending === `${rowId}:probe` ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
          Test {CAPABILITY_LABELS[capability]} capability
        </button>
        <button
          type="button"
          onClick={() => onPatch(row, { isEnabled: !row.isEnabled }, `${rowId}:enable`)}
          disabled={pending !== null}
          className={GHOST_PILL}
        >
          {row.isEnabled ? "Disable" : "Enable"}
        </button>
        {!showDeleteConfirm ? (
          <button type="button" onClick={() => setShowDeleteConfirm(true)} disabled={pending !== null} className={DANGER_PILL}>
            <Trash2 className="h-4 w-4" aria-hidden />
            Delete
          </button>
        ) : (
          <>
            <button type="button" onClick={() => onDelete(row)} disabled={pending !== null} className={DANGER_PILL}>
              {pending === `${rowId}:delete` ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Confirm delete
            </button>
            <button type="button" onClick={() => setShowDeleteConfirm(false)} className={GHOST_PILL}>
              Keep
            </button>
          </>
        )}
      </div>
      {actionError[`${rowId}:enable`] ? (
        <p className="mt-2 text-xs text-red-400">{actionError[`${rowId}:enable`]!.message}</p>
      ) : null}
      {actionError[`${rowId}:delete`] ? (
        <p className="mt-2 text-xs text-red-400">{actionError[`${rowId}:delete`]!.message}</p>
      ) : null}
      {actionError[`${rowId}:probe`] ? (
        <p className="mt-2 text-xs text-red-400">{actionError[`${rowId}:probe`]!.message}</p>
      ) : null}
      <p className="mt-3 text-xs text-ink-muted">
        Configuration v{row.configurationVersion} · updated {row.updatedAt.slice(0, 10)} · {row.isEnabled ? "enabled" : "disabled"}
      </p>
    </article>
  );
}

const PROBE_STATUS_WORDS: Record<CapabilityProbeResult["status"], { word: string; text: string; dot: string }> = {
  validated: { word: "Validated", text: "text-emerald-400", dot: "bg-emerald-400" },
  failed: { word: "Failed", text: "text-red-400", dot: "bg-red-400" },
  skipped: { word: "Skipped", text: "text-amber-300", dot: "bg-amber-400" },
};

function ProbeResultView({
  result,
  fullResult,
  capability,
}: {
  result: CapabilityProbeResult | null;
  fullResult: ConfigurationProbeResult;
  capability: Capability;
}) {
  if (!result) {
    return (
      <p className="mt-1 text-xs text-ink-muted">
        The stored test covered other capabilities of this configuration
        ({fullResult.capabilities.map((r) => CAPABILITY_LABELS[r.capability]).join(", ")}); run the
        test again to verify this one.
      </p>
    );
  }
  const status = PROBE_STATUS_WORDS[result.status];
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <span className={`flex items-center gap-1.5 text-sm font-medium ${status.text}`}>
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
        {status.word}
        {result.selectedModelAccepted === true ? " — selected model accepted" : null}
        {result.selectedModelAccepted === false ? " — selected model not accepted" : null}
      </span>
      {result.detail ? <p className="text-xs text-ink-muted">{result.detail}</p> : null}
      {result.status === "failed" ? (
        <p className="text-xs text-red-300">
          Fix the configuration and test again; a failed test blocks enabling this capability.
        </p>
      ) : null}
      {result.status === "skipped" ? (
        <p className="text-xs text-amber-300">
          {capability === "realtime"
            ? "Native realtime sessions are verified with the realtime interview runtime; the configuration is stored unchanged in the meantime."
            : "This preset needs its native-protocol adapter before the test can run; the stored status is untouched until then."}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------- add provider ------------------------------- */

function AddProviderArea({
  capability,
  onCreated,
}: {
  capability: Capability;
  onCreated: (created: ProviderConfigSummary) => void;
}) {
  const [mode, setMode] = useState<"idle" | "preset" | "custom">("idle");
  const [presetName, setPresetName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [list, setList] = useState<ModelListState>(IDLE_MODEL_LIST);
  const [pendingCreate, setPendingCreate] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const presetsForCapability = useMemo(
    () => PRESET_ADAPTERS.filter((preset) => preset.capabilities.includes(capability)),
    [capability],
  );
  const chosenPreset = presetName
    ? PRESET_ADAPTERS.find((p) => p.providerName === presetName) ?? null
    : null;
  const catalogue =
    mode === "preset" && chosenPreset ? suggestionsFor(capability, chosenPreset.providerName) : [];
  const noteById = new Map(catalogue.map((s) => [s.modelId, s.note] as const));

  function reset() {
    setMode("idle");
    setPresetName(null);
    setName("");
    setBaseUrl("");
    setApiKey("");
    setModelId("");
    setList(IDLE_MODEL_LIST);
    setError(null);
  }

  /** Any target change invalidates the loaded list — it belongs to the key. */
  function invalidateList() {
    setList(IDLE_MODEL_LIST);
  }

  /**
   * Owner directive 2026-11-16: once the API key is keyed in, the provider's
   * model list loads via the transient discovery endpoint and the user picks
   * from it. Manual entry is only offered for custom endpoints whose gateway
   * exposes no list and has no catalogue (the honest last resort).
   */
  async function loadList(): Promise<ModelListState> {
    const trimmedKey = apiKey.trim();
    const isPreset = mode === "preset" && chosenPreset !== null;
    if (!trimmedKey) return IDLE_MODEL_LIST;
    if (!isPreset && (!name.trim() || !baseUrl.trim())) return IDLE_MODEL_LIST;
    setList({ state: "loading", models: [], source: null });
    const response = await callApi<DiscoveryResult>("/api/v1/providers/discover-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerType: isPreset ? "preset" : "custom",
        providerName: isPreset ? chosenPreset!.providerName : name.trim(),
        ...(isPreset ? {} : { baseUrl: baseUrl.trim() }),
        apiKey: trimmedKey,
      }),
    });
    const raw: RowModelList = {
      state: "done",
      result: response.ok
        ? response.data
        : { ok: false, errorCode: "provider_error", detail: response.error.message },
    };
    const resolved = resolveModelList(raw, catalogue);
    setList(resolved);
    return resolved;
  }

  async function submit() {
    setError(null);
    if (mode === "preset" && !chosenPreset) return;
    if (mode === "custom" && (!name.trim() || !baseUrl.trim())) {
      setError({ code: "invalid_input", message: "A custom endpoint needs a name and a Base URL." });
      return;
    }
    if (!apiKey.trim()) {
      setError({ code: "missing_credential", message: "An API key is required." });
      return;
    }
    let current = list;
    if (!modelId && current.state !== "ready") {
      current = await loadList();
    }
    if (!modelId && current.state !== "ready") {
      setError({ code: "invalid_input", message: "The model list could not be loaded — fix the error below or enter the model ID manually." });
      return;
    }
    if (!modelId) {
      setError({ code: "invalid_input", message: "Select a model from the list." });
      return;
    }

    setPendingCreate(true);
    const payload = {
      providerType: mode,
      providerName: mode === "preset" ? chosenPreset!.providerName : name.trim(),
      ...(mode === "custom" ? { baseUrl: baseUrl.trim() } : {}),
      apiKey: apiKey.trim(),
      capabilities: { [capability]: { modelId: modelId.trim() } },
    };
    const result = await callApi<{ configuration: ProviderConfigSummary }>(
      "/api/v1/providers/configurations",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    );
    setPendingCreate(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const created = result.data.configuration;
    reset();
    onCreated(created);
  }

  const allowManual = mode === "custom" && list.state === "failed";

  if (mode === "idle") {
    return (
      <div className="rounded-2xl border border-line bg-raised/40 p-4 sm:p-5">
        <span className={LABEL_CLASS}>Add a provider for this capability</span>
        <div className="mt-3 flex flex-col gap-3">
          <div>
            <p className="text-xs font-medium text-ink-soft">Pre-configured providers</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {presetsForCapability.map((preset) => (
                <button
                  key={preset.providerName}
                  type="button"
                  onClick={() => { setMode("preset"); setPresetName(preset.providerName); }}
                  className="cursor-pointer rounded-full border border-line bg-surface px-4 py-2 text-sm text-ink-soft outline-none transition-colors hover:border-emerald-400/70 hover:text-ink focus-visible:ring-2 focus-visible:ring-emerald-400"
                >
                  <Plus className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
                  {preset.displayName}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-ink-soft">Custom configuration</p>
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setMode("custom")}
                className="cursor-pointer rounded-full border border-line bg-surface px-4 py-2 text-sm text-ink-soft outline-none transition-colors hover:border-emerald-400/70 hover:text-ink focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                <Plus className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
                Custom OpenAI-compatible endpoint
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-emerald-400/40 bg-raised/40 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink">
          {mode === "preset" ? `Add ${chosenPreset?.displayName}` : "Add a custom OpenAI-compatible endpoint"}
          <span className="ml-2 text-ink-muted">serving {CAPABILITY_LABELS[capability]}</span>
        </span>
        <button type="button" onClick={reset} className={GHOST_PILL}>
          Cancel
        </button>
      </div>

      <div className="mt-4 flex flex-col gap-4">
        {mode === "preset" && chosenPreset ? (
          <p className="rounded-xl bg-surface px-4 py-2.5 text-xs text-ink-muted">
            Base URL is the provider&apos;s documented endpoint
            (<code className="text-ink-soft">{chosenPreset.defaultBaseUrl}</code>) — preset
            connections always use it, so it is not editable here.
          </p>
        ) : null}
        {mode === "custom" ? (
          <>
            <label className="flex flex-col gap-1.5">
              <span className={LABEL_CLASS}>Configuration name</span>
              <input value={name} onChange={(e) => { setName(e.target.value); invalidateList(); }} onBlur={() => { if (list.state === "idle" || list.state === "failed") void loadList(); }} className={FIELD_CLASS} placeholder="e.g. my-self-hosted-gateway" maxLength={120} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={LABEL_CLASS}>Base URL</span>
              <input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); invalidateList(); }} onBlur={() => { if (list.state === "idle" || list.state === "failed") void loadList(); }} className={FIELD_CLASS} placeholder="https://your-endpoint.example.com/v1" inputMode="url" maxLength={2048} />
            </label>
          </>
        ) : null}
        <label className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); invalidateList(); }}
            onBlur={() => { if (list.state === "idle" || list.state === "failed") void loadList(); }}
            className={`${FIELD_CLASS} font-mono`}
            placeholder="Paste the provider API key"
            autoComplete="off"
            maxLength={4096}
          />
          <span className="text-xs text-ink-muted">
            The provider&apos;s model list loads automatically once the key is entered.
          </span>
        </label>
        <div className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>Model for {CAPABILITY_LABELS[capability]}</span>
          {list.state === "ready" ? (
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className={FIELD_CLASS}
              aria-label={`Model for ${CAPABILITY_LABELS[capability]}`}
            >
              <option value="" disabled>
                Select a model…
              </option>
              {list.models.map((id) => (
                <option key={id} value={id}>
                  {noteById.get(id) ? `${id} (${noteById.get(id)})` : id}
                </option>
              ))}
            </select>
          ) : allowManual ? (
            <input
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className={FIELD_CLASS}
              placeholder="Exact provider model ID"
              maxLength={200}
              aria-label={`Model ID for ${CAPABILITY_LABELS[capability]}`}
            />
          ) : (
            <div className="flex h-11 items-center gap-2 rounded-full bg-raised px-5 text-sm text-ink-muted">
              {list.state === "loading" ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Loading the model list…
                </>
              ) : list.state === "failed" ? (
                "The model list could not be loaded."
              ) : (
                "The provider's model list appears here once the API key is entered."
              )}
            </div>
          )}
          {list.state === "ready" && list.source === "discovery" ? (
            <span className="text-xs text-ink-muted">
              {list.models.length} models loaded from the provider&apos;s list — these are the
              exact IDs your account can use.
            </span>
          ) : null}
          {list.note ? <span className="text-xs text-amber-300">{list.note}</span> : null}
          {list.state === "failed" ? (
            <span>
              <button
                type="button"
                onClick={() => void loadList()}
                disabled={pendingCreate}
                className={GHOST_PILL}
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                Load models
              </button>
            </span>
          ) : null}
        </div>
        {error ? <p className="text-xs text-red-400">{error.message}</p> : null}
        <div className="flex gap-2">
          <button type="button" onClick={submit} disabled={pendingCreate} className={PRIMARY_PILL}>
            {pendingCreate ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
            Save configuration
          </button>
        </div>
        <p className="text-xs text-ink-muted">
          After saving: run the capability test, then enable it for interviews.
        </p>
      </div>
    </div>
  );
}
