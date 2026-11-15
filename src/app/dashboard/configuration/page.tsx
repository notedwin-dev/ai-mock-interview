import { Suspense } from "react";
import Link from "next/link";
import { requireAccount } from "@/lib/auth/guard";
import {
  listProviderConfigurations,
  type ProviderConfigSummary,
} from "@/lib/providers/config";
import { ProviderConfigurator } from "@/components/dashboard/ProviderConfigurator";

/**
 * AI configuration page (FR-PROVIDER-001..009; ADR-028/029/030; owner
 * directive 2026-11-16): the dedicated, capability-first configuration
 * experience. Four independent sections — ASR/STT, interviewer LLM, TTS and
 * the evaluation scorer — each with pre-configured provider chips and its
 * own Custom OpenAI-compatible option (own Base URL, key and exact
 * model_id). Nothing is inherited or substituted across capabilities, so
 * the scorer is configured separately from the interview LLM. The server
 * page only loads credential-free summaries (write-only keys, ADR-0005);
 * every mutation and probe goes through /api/v1/providers/configurations.
 *
 * The dynamic account + data access sits inside a Suspense boundary (this
 * Next.js version streams dynamic routes; same pattern as the dashboard).
 */

async function ConfigurationContent() {
  const { account } = await requireAccount({ role: "candidate" });

  let configurations: ProviderConfigSummary[] = [];
  let loadFailed = false;
  try {
    configurations = await listProviderConfigurations(account.userId);
  } catch {
    loadFailed = true;
  }

  return loadFailed ? (
    <p className="mt-6 rounded-2xl border border-dashed border-line bg-surface/50 p-6 text-sm text-ink-muted">
      Configurations could not be loaded. Try again in a moment.
    </p>
  ) : (
    <ProviderConfigurator initialConfigurations={configurations} />
  );
}

export default function ConfigurationPage() {
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8 lg:py-12">
      <Link
        href="/dashboard"
        className="text-sm text-ink-soft transition-colors hover:text-ink"
      >
        ← Back to dashboard
      </Link>
      <h1 className="mt-4 font-display text-2xl font-semibold tracking-tight text-ink">
        AI configuration
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
        Four independent capabilities, each configured on its own: speech
        recognition (ASR), the interviewer (LLM), voice output (TTS) and the
        evaluation scorer. Each one gets its own provider, API key and exact
        model — nothing is shared or substituted between capabilities, and keys
        are stored encrypted, never shown again after saving.
      </p>
      <div className="mt-6">
        <Suspense fallback={<p className="text-sm text-ink-muted">Loading…</p>}>
          <ConfigurationContent />
        </Suspense>
      </div>
    </main>
  );
}
