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
import { REALTIME_PROVIDERS, realtimeModelFor } from "@/lib/providers/realtime-models";
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

/** Pin row-scoped calls to the exact config when a provider serves several capabilities. */
function rowQuery(row: ProviderConfigSummary): string {
  return `?configId=${encodeURIComponent(row.userProviderConfigurationId)}`;
}

interface ProviderConfiguratorProps {
  initialConfigurations: ProviderConfigSummary[];
}

export function ProviderConfigurator({ initialConfigurations }: ProviderConfiguratorProps) {
  const [rows, setRows] = useState<ProviderConfigSummary[]>(initialConfigurations);
  // ADR-006: pick ONE runtime before any credential is entered.
  const [mode, setMode] = useState<"realtime" | "custom" | null>(() => {
    if (initialConfigurations.some((row) => row.capabilities.realtime)) return "realtime";
    if (
      initialConfigurations.some(
        (row) => row.capabilities.llm || row.capabilities.asr || row.capabilities.tts,
      )
    ) return "custom";
    return null;
  });
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
        `/api/v1/providers/configurations/${encodeURIComponent(row.providerName)}/models${rowQuery(row)}`,
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
        `/api/v1/providers/configurations/${encodeURIComponent(row.providerName)}/probe${rowQuery(row)}`,
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
        `/api/v1/providers/configurations/${encodeURIComponent(row.providerName)}${rowQuery(row)}`,
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
        `/api/v1/providers/configurations/${encodeURIComponent(row.providerName)}${rowQuery(row)}`,
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
   * existing credential stays untouched. Realtime models are admin-fixed:
   * the candidate only supplies a credential, never a model ID.
   */
  async function addRealtime(
    providerName: string,
    apiKey: string | null,
  ): Promise<boolean> {
    const modelId = realtimeModelFor(providerName);
    if (!modelId) {
      setActionError((current) => ({
        ...current,
        [`realtime:${providerName}`]: {
          code: "invalid_input",
          message: "This realtime provider is not available.",
        },
      }));
      return false;
    }
    const key = `realtime:${providerName}`;
    const existing = rows.find(
      (row) => row.providerType === "preset" && row.providerName === providerName,
    );
    const error = await runAction(key, async () => {
      if (existing) {
        if (existing.capabilities.realtime) return null;
        const result = await callApi<{ configuration: ProviderConfigSummary }>(
          `/api/v1/providers/configurations/${encodeURIComponent(providerName)}${rowQuery(existing)}`,
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

  if (mode === null) {
    return (
      <ModeSelector
        onSelect={(selected) => setMode(selected)}
        configured={rows.length > 0}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-5 py-3">
        <span className="text-sm text-ink-muted">
          Runtime:{" "}
          <strong className="text-ink">
            {mode === "realtime" ? "Pre-configured Mode (Fixed Providers)" : "Advanced Mode (Custom Providers)"}
          </strong>
        </span>
        <button
          type="button"
          onClick={() => setMode(null)}
          disabled={rows.length > 0}
          className={GHOST_PILL}
        >
          Change mode
        </button>
      </div>
      {rows.length > 0 ? (
        <p className="text-xs text-ink-muted" role="status">
          A runtime with saved credentials is fixed — delete its configuration before
          changing modes.
        </p>
      ) : null}

      {mode === "realtime" ? (
        <PreconfiguredModePanel
          rows={rows}
          pending={pending}
          actionError={actionError}
          probeByRow={probeByRow}
          onProbe={runProbe}
          onPatch={patchRow}
          onDelete={deleteRow}
          onAddRealtime={addRealtime}
        />
      ) : (
        <section
          aria-labelledby="custom-config-heading"
          className="overflow-hidden rounded-3xl border border-line bg-surface"
        >
          <OptionCardHeader
            id="custom-config-heading"
            title="Advanced Mode"
            badge="Custom providers"
            subtitle="Pick a provider tag per capability, or Custom to supply your own endpoint. Each capability stays independent."
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
          </div>
        </section>
      )}
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

/* --------------------------- mode selection --------------------------------- */

function ModeSelector({
  onSelect,
  configured,
}: {
  onSelect: (mode: "realtime" | "custom") => void;
  configured: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-center gap-3 text-xs text-ink-muted" aria-label="Configuration steps">
        {["Choose mode", "Configure credentials", "Verify & enable"].map((step, index) => (
          <span key={step} className="flex items-center gap-3">
            <span className={`flex h-6 w-6 items-center justify-center rounded-full border ${index === 0 ? "border-emerald-400 bg-emerald-400 text-emerald-950" : "border-line text-ink-muted"}`}>
              {index + 1}
            </span>
            {step}
            {index < 2 ? <span aria-hidden>→</span> : null}
          </span>
        ))}
      </div>
      <h1 className="text-center font-display text-2xl font-semibold tracking-tight text-ink">
        Configure your preferred AI model providers
      </h1>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-3xl border border-line bg-surface p-6">
          <h2 className="font-display text-lg font-semibold text-ink">Pre-configured Mode (Fixed Providers)</h2>
          <p className="mt-2 text-sm text-ink-muted">
            One native realtime agent handles voice, understanding and speech. The
            model is fixed by the administrator — you only add a credential.
          </p>
          <div className="mt-5 grid grid-cols-2 gap-3">
            {REALTIME_PROVIDERS.map((spec) => (
              <div key={spec.providerName} className={`flex flex-col items-center gap-2 rounded-2xl border border-line bg-raised/40 p-3 text-center ${spec.modelId ? "" : "opacity-50"}`}>
                <MonogramTile providerName={spec.providerName} monogram={spec.monogram} />
                <span className="text-xs text-ink">{spec.title}</span>
                {spec.modelId ? null : <span className="text-[10px] text-ink-muted">Unavailable</span>}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onSelect("realtime")}
            className={`${PRIMARY_PILL} mt-6 w-full justify-center`}
          >
            Choose pre-configured
          </button>
        </section>
        <section className="rounded-3xl border border-line bg-surface p-6">
          <h2 className="font-display text-lg font-semibold text-ink">Advanced Mode (Custom Providers)</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">
            You can customize your preferred ASR, LLM, TTS and scorer providers in
            this mode. Each capability gets its own provider tag, API key, Base URL
            and exact model ID.
          </p>
          <button
            type="button"
            onClick={() => onSelect("custom")}
            className={`${PRIMARY_PILL} mt-6 w-full justify-center`}
          >
            Choose advanced
          </button>
        </section>
      </div>
      {configured ? (
        <p className="text-center text-xs text-ink-muted" role="status">
          A runtime is already configured — delete its saved configuration first to
          switch modes.
        </p>
      ) : null}
    </div>
  );
}

interface PreconfiguredModePanelProps {
  rows: ProviderConfigSummary[];
  pending: string | null;
  actionError: Record<string, ApiError>;
  probeByRow: Record<string, ConfigurationProbeResult>;
  onProbe: (row: ProviderConfigSummary) => void;
  onPatch: (row: ProviderConfigSummary, patch: Record<string, unknown>, key: string) => Promise<boolean>;
  onDelete: (row: ProviderConfigSummary) => void;
  onAddRealtime: (providerName: string, apiKey: string | null) => Promise<boolean>;
}

function PreconfiguredModePanel(props: PreconfiguredModePanelProps) {
  const [formFor, setFormFor] = useState<string | null>(null);
  return (
    <section aria-labelledby="preconfigured-heading" className="rounded-3xl border border-line bg-surface p-5 sm:p-6">
      <h2 id="preconfigured-heading" className="font-display text-lg font-semibold text-ink">
        Pre-configured Realtime Agents
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        Pick one native agent. Its model is fixed by the administrator; only a
        credential is required.
      </p>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {REALTIME_PROVIDERS.map((spec) => {
          const configured = props.rows.find(
            (row) => row.providerType === "preset" && row.providerName === spec.providerName,
          );
          const available = Boolean(spec.modelId);
          return (
            <div key={spec.providerName} className="rounded-2xl border border-line bg-raised/40 p-4">
              <div className="flex items-start gap-3">
                <MonogramTile providerName={spec.providerName} monogram={spec.monogram} />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">{spec.title}</p>
                  <p className="mt-0.5 text-xs text-ink-muted">{spec.note}</p>
                  {spec.modelId ? (
                    <p className="mt-1 text-xs text-ink-soft">Model: <code className="rounded bg-surface px-1.5 py-0.5">{spec.modelId}</code></p>
                  ) : null}
                  {configured ? (
                    <p className={`mt-1 text-xs ${configured.credentialStatus === "valid" ? "text-emerald-400" : "text-amber-300"}`}>
                      {configured.credentialStatus === "valid" ? "Validated" : "Not validated yet"} · {configured.isEnabled ? "enabled" : "disabled"}
                    </p>
                  ) : null}
                </div>
              </div>
              {configured ? (
                <ConfiguredRealtimeRow row={configured} {...props} />
              ) : formFor === spec.providerName && available ? (
                <FixedKeyForm
                  providerName={spec.providerName}
                  modelId={spec.modelId!}
                  formKey={`realtime:${spec.providerName}`}
                  pending={props.pending}
                  actionError={props.actionError}
                  onSubmit={async (apiKey) => {
                    const ok = await props.onAddRealtime(spec.providerName, apiKey);
                    if (ok) setFormFor(null);
                    return ok;
                  }}
                  onCancel={() => setFormFor(null)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setFormFor(spec.providerName)}
                  disabled={!available || props.pending !== null}
                  className={`${GHOST_PILL} mt-4 w-full justify-center`}
                >
                  {available ? "Set up" : "Unavailable"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ConfiguredRealtimeRow({
  row,
  pending,
  actionError,
  probeByRow,
  onProbe,
  onPatch,
  onDelete,
}: {
  row: ProviderConfigSummary;
  pending: string | null;
  actionError: Record<string, ApiError>;
  probeByRow: Record<string, ConfigurationProbeResult>;
  onProbe: (row: ProviderConfigSummary) => void;
  onPatch: (row: ProviderConfigSummary, patch: Record<string, unknown>, key: string) => Promise<boolean>;
  onDelete: (row: ProviderConfigSummary) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const probe = probeByRow[row.userProviderConfigurationId]?.capabilities.find(
    (result) => result.capability === "realtime",
  );
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => onProbe(row)} disabled={pending !== null} className={GHOST_PILL}>Test capability</button>
        <button
          type="button"
          onClick={() => void onPatch(row, { isEnabled: !row.isEnabled }, `${row.userProviderConfigurationId}:enable`)}
          disabled={pending !== null}
          className={GHOST_PILL}
        >
          {row.isEnabled ? "Disable" : "Enable"}
        </button>
        {!confirm ? (
          <button type="button" onClick={() => setConfirm(true)} disabled={pending !== null} className={DANGER_PILL}>Delete</button>
        ) : (
          <>
            <button type="button" onClick={() => onDelete(row)} disabled={pending !== null} className={DANGER_PILL}>Confirm delete</button>
            <button type="button" onClick={() => setConfirm(false)} className={GHOST_PILL}>Keep</button>
          </>
        )}
      </div>
      {probe ? <p className="text-xs text-ink-muted">Last test: {probe.status}</p> : null}
      {actionError[`${row.userProviderConfigurationId}:enable`] ? (
        <p className="text-xs text-red-400">{actionError[`${row.userProviderConfigurationId}:enable`]!.message}</p>
      ) : null}
    </div>
  );
}

function FixedKeyForm({
  providerName,
  modelId,
  formKey,
  pending,
  actionError,
  onSubmit,
  onCancel,
}: {
  providerName: string;
  modelId: string;
  formKey: string;
  pending: string | null;
  actionError: Record<string, ApiError>;
  onSubmit: (apiKey: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="mt-4 flex flex-col gap-3 rounded-xl border border-emerald-400/40 bg-surface p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!apiKey.trim()) { setError("An API key is required."); return; }
        void onSubmit(apiKey.trim());
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-ink">Set up {providerName}</span>
        <button type="button" onClick={onCancel} className={GHOST_PILL}>Cancel</button>
      </div>
      <p className="text-xs text-ink-muted">Fixed model: <code className="rounded bg-raised px-1.5 py-0.5">{modelId}</code></p>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-muted">API key</span>
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          className={FIELD_CLASS}
          placeholder="Paste the provider API key"
          autoComplete="off"
          maxLength={4096}
          aria-label={`API key for ${providerName}`}
        />
      </label>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      {actionError[formKey] ? <p className="text-xs text-red-400">{actionError[formKey]!.message}</p> : null}
      <button type="submit" disabled={pending !== null} className={PRIMARY_PILL}>Save configuration</button>
    </form>
  );
}

/* --------------------------- shared presentation ----------------------------- */

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

/** Two-letter monogram used in Advanced mode provider tags. */
function providerMonogram(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

function ProviderTag({
  label,
  selected,
  dimmed,
  onClick,
}: {
  label: string;
  selected: boolean;
  dimmed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      disabled={dimmed}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald-400 ${
        dimmed
          ? "cursor-not-allowed border-line bg-surface/40 text-ink-muted opacity-40"
          : selected
            ? "border-emerald-400 bg-emerald-400/10 text-ink"
            : "cursor-pointer border-line bg-surface text-ink-soft hover:border-emerald-400/70 hover:text-ink"
      }`}
    >
      <span
        aria-hidden
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-[10px] font-bold tracking-wide ${
          selected ? "border-emerald-400/50 bg-emerald-400/15 text-emerald-300" : "border-line bg-raised text-ink-soft"
        }`}
      >
        {providerMonogram(label)}
      </span>
      {label}
    </button>
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
              No configuration serves this capability yet. Pick a provider tag below.
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
          <AddProviderArea
            capability={section.capability}
            rows={props.rows}
            onCreated={props.onCreated}
          />
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
            {row.providerType === "preset" ? "Preset" : "Custom endpoint"}
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
  rows,
  onCreated,
}: {
  capability: Capability;
  rows: ProviderConfigSummary[];
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

  // Saved providers collapse: once a preset serves this capability it is
  // removed from the tag list, so it can never be added twice.
  const presetsForCapability = useMemo(() => {
    const configured = new Set(
      rows
        .filter((row) => row.providerType === "preset" && row.capabilities[capability])
        .map((row) => row.providerName),
    );
    return PRESET_ADAPTERS.filter(
      (preset) => preset.capabilities.includes(capability) && !configured.has(preset.providerName),
    );
  }, [capability, rows]);
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

  // One tag row, visible in both states: selecting a tag greys out the rest,
  // and saved providers are filtered out of the list entirely.
  const tagRow = (
    <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Provider tags">
      {presetsForCapability.map((preset) => {
        const selected = mode === "preset" && presetName === preset.providerName;
        return (
          <ProviderTag
            key={preset.providerName}
            label={preset.displayName}
            selected={selected}
            dimmed={mode !== "idle" && !selected}
            onClick={() => { setMode("preset"); setPresetName(preset.providerName); }}
          />
        );
      })}
      <ProviderTag
        label="Custom"
        selected={mode === "custom"}
        dimmed={mode !== "idle" && mode !== "custom"}
        onClick={() => setMode("custom")}
      />
    </div>
  );

  if (mode === "idle") {
    return (
      <div className="rounded-2xl border border-line bg-raised/40 p-4 sm:p-5">
        <span className={LABEL_CLASS}>Add a provider for this capability</span>
        {tagRow}
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
      {tagRow}

      <div className="mt-4 flex flex-col gap-4 border-t border-line pt-4">
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
