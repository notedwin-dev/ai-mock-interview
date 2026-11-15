import { Suspense } from "react";
import Link from "next/link";
import { requireAccount } from "@/lib/auth/guard";
import {
  listProviderConfigurations,
  type ProviderConfigSummary,
} from "@/lib/providers/config";
import { ProviderConfigurator } from "@/components/dashboard/ProviderConfigurator";

/**
 * AI configuration page (FR-PROVIDER-001..009; ADR-028/029/030; owner mockup
 * + directive 2026-11-16): the dedicated configuration experience mirroring
 * the approved runtime architecture (ADR-006) — Option 1, pre-configured
 * realtime agents (native integrations) and Option 2, the composable custom
 * pipeline (ASR/STT, LLM, TTS and the independent scorer). Keys are stored
 * encrypted and never shown again (write-only, ADR-0005); the server page
 * only loads credential-free summaries, and every mutation and probe goes
 * through /api/v1/providers/configurations.
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
        Choose how your interviews run: a pre-configured realtime agent that
        handles voice, understanding and speech natively — or a custom pipeline
        where you pick the provider, API key and exact model for each
        capability yourself. Keys are stored encrypted and never shown again
        after saving.
      </p>
      <div className="mt-6">
        <Suspense fallback={<p className="text-sm text-ink-muted">Loading…</p>}>
          <ConfigurationContent />
        </Suspense>
      </div>
    </main>
  );
}
