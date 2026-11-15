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
 * directive §6, 2026-11-16). Four independent capability sections — ASR/STT,
 * LLM, TTS and the evaluation scorer — each with pre-configured provider
 * chips and its own Custom OpenAI-compatible option (own Base URL, API key
 * and exact model_id). Nothing is inherited or substituted across
 * capabilities; the scorer is configured independently of the interview LLM.
 *
 * Wire-only invariants preserved here: credentials are write-only (sent to
 * the API, never displayed or stored in client state beyond a password
 * field), model IDs are always the exact provider strings (discovery
 * populates choices, manual entry always available), and a failed test is
 * reported honestly — never smoothed over.
 */

const CAPABILITY_SECTIONS = [
  {
    capability: "asr",
    title: "Speech recognition (ASR)",
    role: "Transcribes the candidate's voice for the interviewer.",
    Icon: Mic,
  },
  {
    capability: "llm",
    title: "Interviewer (LLM)",
    role: "Conducts the interview, asks questions and follows up.",
    Icon: Brain,
  },
  {
    capability: "tts",
    title: "Voice output (TTS)",
    role: "Speaks the interviewer's turns aloud.",
    Icon: AudioLines,
  },
  {
    capability: "scorer",
    title: "Evaluation scorer",
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

/** Which model list a configuration row has loaded (or why it has none). */
interface ModelState {
  state: "loading" | "ready" | "manual";
  models: string[];
  note?: string;
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
  const [modelsByRow, setModelsByRow] = useState<Record<string, ModelState>>({});
  const [probeByRow, setProbeByRow] = useState<Record<string, ConfigurationProbeResult>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Record<string, ApiError>>({});
  const [collapsed, setCollapsed] = useState<Record<Capability, boolean>>({
    asr: true,
    llm: false,
    tts: true,
    scorer: true,
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
    const key = `${rowId}:models`;
    setModelsByRow((current) => ({
      ...current,
      [rowId]: { state: "loading", models: [] },
    }));
    // GET …/models answers with the DiscoveryResult union: ok:true with the
    // model IDs (null when the provider has no list endpoint), or ok:false
    // with the probe error taxonomy. Everything below is reported honestly —
    // a failed discovery never fabricates a model list.
    const finish = (next: ModelState) =>
      setModelsByRow((current) => ({ ...current, [rowId]: next }));
    await runAction(key, async () => {
      const result = await callApi<DiscoveryResult>(
        `/api/v1/providers/configurations/${encodeURIComponent(row.providerName)}/models`,
        { cache: "no-store" },
      );
      if (!result.ok) {
        finish({ state: "manual", models: [], note: result.error.message });
        return null;
      }
      if (!result.data.ok) {
        finish({ state: "manual", models: [], note: result.data.detail });
        return null;
      }
      if (result.data.models && result.data.models.length > 0) {
        finish({ state: "ready", models: result.data.models });
        return null;
      }
      finish({
        state: "manual",
        models: [],
        note: "This provider exposes no model list — enter the exact model ID manually.",
      });
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

  return (
    <div className="flex flex-col gap-6">
      <ReadinessStrip rows={rows} onJump={(capability) => setCollapsed((c) => ({ ...c, [capability]: false }))} />
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
          onCreated={async (created) => {
            const fresh = await refresh();
            const row =
              fresh.find((r) => r.providerName === created.providerName) ?? created;
            await findModels(row);
          }}
        />
      ))}
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

/* --------------------------------- section ---------------------------------- */

type SectionMeta = (typeof CAPABILITY_SECTIONS)[number];

interface CapabilitySectionProps {
  section: SectionMeta;
  rows: ProviderConfigSummary[];
  collapsed: boolean;
  onToggle: () => void;
  modelsByRow: Record<string, ModelState>;
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
      className="rounded-3xl border border-line bg-surface"
      aria-labelledby={`${section.capability}-heading`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex w-full cursor-pointer items-center gap-4 rounded-3xl p-5 text-left outline-none transition-colors hover:bg-raised/40 focus-visible:ring-2 focus-visible:ring-emerald-400 sm:p-6"
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
  const modelState = modelsByRow[rowId];
  const probe = probeByRow[rowId];
  const probeForCapability = probe?.capabilities.find((r) => r.capability === capability);
  const suggestions = suggestionsFor(capability, row.providerType === "preset" ? row.providerName : null);
  const suggestionIds = useMemo(() => suggestions.map((s) => s.modelId), [suggestions]);

  const modelBusy = pending === `${rowId}:model` || modelState?.state === "loading";
  const datalistId = `models-${rowId}-${capability}`;

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
        <span className={LABEL_CLASS}>Model ID ({CAPABILITY_LABELS[capability]})</span>
        {!editingModel ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <code className="rounded-full bg-surface px-3 py-1.5 text-sm text-ink">
              {servingCapability?.modelId}
            </code>
            <button type="button" onClick={() => { setModelDraft(servingCapability?.modelId ?? ""); setEditingModel(true); }} className={GHOST_PILL}>
              Change
            </button>
            <button
              type="button"
              onClick={() => {
                // Discovery results (list or failure note) are rendered in the
                // model editor, so open it when picking a model is the goal.
                if (!editingModel) {
                  setModelDraft(servingCapability?.modelId ?? "");
                  setEditingModel(true);
                }
                onFindModels(row);
              }}
              disabled={modelBusy || pending !== null}
              className={GHOST_PILL}
            >
              {modelState?.state === "loading" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
              Find models
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
              <input
                list={suggestionIds.length > 0 ? datalistId : undefined}
                value={modelDraft}
                onChange={(event) => setModelDraft(event.target.value)}
                className={FIELD_CLASS}
                placeholder="Exact provider model ID"
                aria-label={`Model ID for ${CAPABILITY_LABELS[capability]}`}
                maxLength={200}
              />
              {suggestionIds.length > 0 ? (
                <datalist id={datalistId}>
                  {suggestions.map((s) => (
                    <option key={s.modelId} value={s.modelId}>
                      {s.note ? `${s.modelId} (${s.note})` : s.modelId}
                    </option>
                  ))}
                </datalist>
              ) : null}
              <div className="flex gap-2">
                <button type="submit" disabled={modelBusy || pending !== null} className={PRIMARY_PILL}>
                  {modelBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
                  Save model
                </button>
                <button type="button" onClick={() => setEditingModel(false)} className={GHOST_PILL}>
                  Cancel
                </button>
              </div>
            </div>
            {modelState?.state === "ready" && modelState.models.length > 0 ? (
              <p className="text-xs text-ink-muted">
                {modelState.models.length} models discovered — pick one from the list or type an exact ID.
                {modelState.models.includes(servingCapability?.modelId ?? "") ? " The saved model is in the list." : ""}
              </p>
            ) : null}
            {modelState?.note ? <p className="text-xs text-amber-300">{modelState.note}</p> : null}
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
            <span className="text-sm text-ink-soft">Stored — write-only, never shown again (ADR-0005).</span>
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
          <ProbeResultView result={probeForCapability ?? null} fullResult={probe} />
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
}: {
  result: CapabilityProbeResult | null;
  fullResult: ConfigurationProbeResult;
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
          This preset needs its native-protocol adapter before the test can run; the stored
          status is untouched until then.
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
  const [pendingCreate, setPendingCreate] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const presetsForCapability = useMemo(
    () => PRESET_ADAPTERS.filter((preset) => preset.capabilities.includes(capability)),
    [capability],
  );
  const chosenPreset = presetName
    ? PRESET_ADAPTERS.find((p) => p.providerName === presetName) ?? null
    : null;
  const suggestions = mode === "preset" && chosenPreset
    ? suggestionsFor(capability, chosenPreset.providerName)
    : [];

  function reset() {
    setMode("idle");
    setPresetName(null);
    setName("");
    setBaseUrl("");
    setApiKey("");
    setModelId("");
    setError(null);
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
    if (!modelId.trim()) {
      setError({ code: "invalid_input", message: "Enter the exact provider model ID." });
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
              <input value={name} onChange={(e) => setName(e.target.value)} className={FIELD_CLASS} placeholder="e.g. my-self-hosted-gateway" maxLength={120} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={LABEL_CLASS}>Base URL</span>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className={FIELD_CLASS} placeholder="https://your-endpoint.example.com/v1" inputMode="url" maxLength={2048} />
            </label>
          </>
        ) : null}
        <label className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>API key</span>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className={`${FIELD_CLASS} font-mono`} placeholder="Paste the provider API key" autoComplete="off" maxLength={4096} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>Model ID for {CAPABILITY_LABELS[capability]}</span>
          <input
            list={suggestions.length > 0 ? "add-model-suggestions" : undefined}
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            className={FIELD_CLASS}
            placeholder="Exact provider model ID"
            maxLength={200}
          />
          {suggestions.length > 0 ? (
            <>
              <datalist id="add-model-suggestions">
                {suggestions.map((s) => (
                  <option key={s.modelId} value={s.modelId}>
                    {s.note ? `${s.modelId} (${s.note})` : s.modelId}
                  </option>
                ))}
              </datalist>
              <span className="text-xs text-ink-muted">
                Suggestions come from the approved model catalogue — after saving, run
                &ldquo;Find models&rdquo; to load the exact IDs your account can use.
              </span>
            </>
          ) : (
            <span className="text-xs text-ink-muted">
              Enter the exact model ID your account exposes.
            </span>
          )}
        </label>
        {error ? <p className="text-xs text-red-400">{error.message}</p> : null}
        <div className="flex gap-2">
          <button type="button" onClick={submit} disabled={pendingCreate} className={PRIMARY_PILL}>
            {pendingCreate ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
            Save configuration
          </button>
        </div>
        <p className="text-xs text-ink-muted">
          After saving: pick the exact model from discovery, run the capability test, then
          enable it for interviews.
        </p>
      </div>
    </div>
  );
}
