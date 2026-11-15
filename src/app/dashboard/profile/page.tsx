import Link from "next/link";
import { requireAccount } from "@/lib/auth/guard";
import { listProviderConfigurations } from "@/lib/providers/config";

/**
 * Minimal profile page: the read-only fix-it destination for provider
 * readiness issues surfaced on the dashboard and setup wizard. Status is
 * always dot + word, never colour alone; the rows use the rehearsal-log
 * language (ruled list, one panel). Editing and probing arrive with the
 * provider configuration surface (M2); resume and visibility management
 * arrive with the profile slice.
 */

const CREDENTIAL_STATUS: Record<string, { word: string; dot: string; text: string }> = {
  valid: {
    word: "Validated",
    dot: "bg-emerald-600 dark:bg-emerald-400",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  unvalidated: {
    word: "Not validated yet",
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-300",
  },
  invalid: {
    word: "Check failed",
    dot: "bg-red-600 dark:bg-red-400",
    text: "text-red-700 dark:text-red-300",
  },
};

const CAPABILITY_LABELS: Record<string, string> = {
  asr: "Speech recognition",
  llm: "Interviewer",
  tts: "Voice output",
};

export default async function Page() {
  const { account } = await requireAccount({ role: "candidate" });
  const configurations = await listProviderConfigurations(account.userId);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8 lg:py-12">
      <Link
        href="/dashboard"
        className="text-sm text-ink-soft transition-colors hover:text-ink"
      >
        ← Back to dashboard
      </Link>
      <h1 className="mt-4 font-display text-2xl font-semibold tracking-tight text-ink">
        Profile
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        Signed in as {account.email} ({account.accountRole}).
      </p>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-ink">Provider configurations</h2>
        {configurations.length === 0 ? (
          <div className="mt-2 rounded-xl border border-line bg-card p-5">
            <p className="text-sm text-ink-soft">
              No provider configurations yet. Interviews need at least one
              enabled configuration serving the interviewer (LLM) capability.
            </p>
          </div>
        ) : (
          <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-card">
            {configurations.map((row) => {
              const credentials =
                CREDENTIAL_STATUS[row.credentialStatus] ?? CREDENTIAL_STATUS.unvalidated;
              return (
                <li key={row.userProviderConfigurationId} className="p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-ink">
                      {row.providerName}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                      <span
                        className={`flex items-center gap-1.5 font-medium ${credentials.text}`}
                      >
                        <span
                          aria-hidden
                          className={`h-1.5 w-1.5 rounded-full ${credentials.dot}`}
                        />
                        {credentials.word}
                      </span>
                      <span className="flex items-center gap-1.5 text-ink-soft">
                        <span
                          aria-hidden
                          className={`h-1.5 w-1.5 rounded-full ${
                            row.isEnabled ? "bg-emerald-600 dark:bg-emerald-400" : "bg-ink-muted/60"
                          }`}
                        />
                        {row.isEnabled ? "Enabled" : "Disabled"}
                      </span>
                    </span>
                  </div>
                  <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {Object.entries(row.capabilities).map(
                      ([capability, settings]) =>
                        settings ? (
                          <li key={capability} className="text-xs text-ink-muted">
                            {CAPABILITY_LABELS[capability] ?? capability} serving{" "}
                            {settings.modelId}
                          </li>
                        ) : null,
                    )}
                  </ul>
                  <p className="mt-2 text-xs text-ink-muted">
                    Updated {row.updatedAt.slice(0, 10)}, configuration v
                    {row.configurationVersion}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-4 text-xs text-ink-muted">
          Configuration editing and credential probing are available through the
          provider configuration API; the configuration UI arrives in an
          upcoming slice. Resume and visibility management arrive with the
          profile slice.
        </p>
      </section>
    </main>
  );
}
