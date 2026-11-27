import Link from "next/link";
import { requireAccount } from "@/lib/auth/guard";
import { getActiveRuntimeMode, listProviderConfigurations } from "@/lib/providers/config";
import { selectRuntime } from "@/lib/interview/runtime";
import { VoiceGenerationRoom } from "@/components/interview/VoiceGenerationRoom";

// Auth uses connection(); keep this per-request so the Suspense stream settles.
export const instant = false;

/** Voice-first interview planning (FR-SETUP-006), on the approved LiveKit stack. */
export default async function GeneratePage() {
  const { account } = await requireAccount({ role: "candidate" });
  const runtime = selectRuntime(
    await listProviderConfigurations(account.userId),
    await getActiveRuntimeMode(account.userId),
  );

  if (!runtime.ready) {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8 lg:py-12">
        <Link href="/dashboard" className="text-sm text-ink-soft hover:text-ink">← Back to dashboard</Link>
        <h1 className="mt-4 font-display text-2xl font-semibold text-ink">Plan interview by voice</h1>
        <p className="mt-3 text-sm text-ink-muted">
          Set up a validated runtime in AI configuration first — the voice planner
          needs a working connection before it can create your interview.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 lg:px-8">
      <VoiceGenerationRoom />
    </main>
  );
}
