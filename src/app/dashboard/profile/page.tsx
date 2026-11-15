import Link from "next/link";
import { requireAccount } from "@/lib/auth/guard";
import { listProviderConfigurations } from "@/lib/providers/config";

/**
 * Minimal profile page: the read-only fix-it destination for provider
 * readiness issues surfaced on the dashboard and setup wizard. Editing and
 * probing arrive with the provider configuration surface (M2); resume and
 * visibility management arrive with the profile slice.
 */
export default async function Page() {
  const { account } = await requireAccount({ role: "candidate" });
  const configurations = await listProviderConfigurations(account.userId);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8 lg:py-12">
      <Link
        href="/dashboard"
        className="text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        ← Back to dashboard
      </Link>
      <h1 className="mt-4 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        Profile
      </h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Signed in as {account.email} ({account.accountRole}).
      </p>

      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Provider configurations
        </h2>
        {configurations.length === 0 ? (
          <div className="mt-2 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              No provider configurations yet. Interviews need at least one
              enabled configuration serving the LLM capability.
            </p>
          </div>
        ) : (
          <ul className="mt-2 flex flex-col gap-3">
            {configurations.map((row) => (
              <li
                key={row.userProviderConfigurationId}
                className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {row.providerName}
                  </span>
                  <span className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      {row.providerType}
                    </span>
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      credentials: {row.credentialStatus}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 ${
                        row.isEnabled
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300"
                          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                      }`}
                    >
                      {row.isEnabled ? "enabled" : "disabled"}
                    </span>
                  </span>
                </div>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {Object.entries(row.capabilities).map(
                    ([capability, settings]) =>
                      settings ? (
                        <li
                          key={capability}
                          className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                        >
                          {capability} · {settings.modelId}
                        </li>
                      ) : null,
                  )}
                </ul>
                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  Updated {row.updatedAt.slice(0, 10)} · configuration v
                  {row.configurationVersion}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-xs text-zinc-600 dark:text-zinc-400">
          Configuration editing and credential probing are available through the
          provider configuration API; the configuration UI arrives in an
          upcoming slice. Resume and visibility management arrive with the
          profile slice.
        </p>
      </section>
    </main>
  );
}
