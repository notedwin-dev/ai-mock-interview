import Link from "next/link";
import Image from "next/image";
import { AudioLines, Brain, Mic } from "lucide-react";
import type { ProviderConfigSummary } from "@/lib/providers/config";
import illustration from "../../../public/illustration.png";

/**
 * Dashboard hero banner + signal-chain strip (PrepWise-adapted, round 4).
 * The banner pairs the round-ready headline with the practice illustration
 * and one clear action; the strip below mirrors the candidate's provider
 * pipeline (ASR → LLM → TTS) with real credential states — never key
 * material (ADR-0005). Green means ready/live, amber needs attention, red is
 * failure only. Server components — links only, no client JS.
 */

const CHAIN_NODES = [
  { capability: "asr", label: "Your voice", hint: "Microphone input", Icon: Mic },
  { capability: "llm", label: "The interviewer", hint: "AI question and follow-up", Icon: Brain },
  { capability: "tts", label: "Voice out", hint: "Spoken responses", Icon: AudioLines },
] as const;

type ChainCapability = (typeof CHAIN_NODES)[number]["capability"];

const PRIMARY_PILL =
  "inline-flex h-11 cursor-pointer items-center rounded-full bg-emerald-400 px-6 text-sm font-semibold text-emerald-950 outline-none transition-all hover:bg-emerald-300 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-emerald-400";

function servingRow(
  configurations: ProviderConfigSummary[],
  capability: ChainCapability,
): ProviderConfigSummary | null {
  return (
    configurations.find((row) => row.isEnabled && row.capabilities[capability]) ??
    null
  );
}

/**
 * Node state in the chain strip: provider name once validated, amber while
 * unvalidated, red after a failed check, dim when nothing is set up.
 */
function nodeState(row: ProviderConfigSummary | null) {
  if (!row) {
    return {
      dot: "bg-ink-muted/60",
      word: "Not set up",
      tone: "text-ink-muted",
    };
  }
  switch (row.credentialStatus) {
    case "valid":
      return {
        dot: "bg-emerald-400",
        word: row.providerName,
        tone: "text-emerald-400",
      };
    case "unvalidated":
      return {
        dot: "bg-amber-400",
        word: `${row.providerName}, not validated yet`,
        tone: "text-amber-300",
      };
    default:
      return {
        dot: "bg-red-400",
        word: `${row.providerName}, check failed`,
        tone: "text-red-400",
      };
  }
}

const UNKNOWN_STATE = {
  dot: "bg-ink-muted/60",
  word: "Unknown",
  tone: "text-ink-muted",
} as const;

interface SignalChainProps {
  configurations: ProviderConfigSummary[];
  readinessFailed: boolean;
}

export function ConsoleBanner({
  configurations,
  readinessFailed,
}: SignalChainProps) {
  const interviewerReady =
    !readinessFailed && servingRow(configurations, "llm") !== null;

  return (
    <section className="rounded-3xl border border-line bg-raised p-8 sm:p-10 lg:p-12">
      <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-center">
        <div>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Ready for a round?
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-muted sm:text-base">
            {readinessFailed
              ? "Pipeline status could not be loaded. Check back shortly."
              : interviewerReady
                ? "Your signal chain is live. Set the scene, then step into the room."
                : "The interviewer needs a working connection before a session can start."}
          </p>
          <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            {interviewerReady ? (
              <Link href="/dashboard/interview/new" className={PRIMARY_PILL}>
                Start a new interview
              </Link>
            ) : (
              <>
                <button
                  type="button"
                  disabled
                  aria-disabled
                  className="inline-flex h-11 cursor-not-allowed items-center rounded-full bg-surface px-6 text-sm font-semibold text-ink-muted"
                >
                  Start a new interview
                </button>
                {!readinessFailed ? (
                  <Link
                    href="/dashboard/profile"
                    className="text-sm font-medium text-emerald-400 underline decoration-emerald-400/40 underline-offset-4 outline-none transition-colors hover:text-emerald-300 focus-visible:ring-2 focus-visible:ring-emerald-400"
                  >
                    Set up the interviewer connection
                  </Link>
                ) : null}
              </>
            )}
          </div>
        </div>
        <Image
          src={illustration}
          alt=""
          aria-hidden
          className="hidden h-44 object-contain lg:block"
        />
      </div>
    </section>
  );
}

export function ChainStrip({ configurations, readinessFailed }: SignalChainProps) {
  const interviewerReady =
    !readinessFailed && servingRow(configurations, "llm") !== null;

  return (
    <section
      aria-label="Voice pipeline status"
      className="rounded-2xl border border-line bg-surface p-4 sm:p-5"
    >
      <ul className="grid gap-2 sm:grid-cols-3 sm:gap-4">
        {CHAIN_NODES.map((node) => {
          const row = servingRow(configurations, node.capability);
          const state = readinessFailed ? UNKNOWN_STATE : nodeState(row);
          return (
            <li key={node.capability}>
              <Link
                href="/dashboard/profile"
                className="flex items-center gap-3 rounded-xl px-1.5 py-1.5 outline-none transition-colors hover:bg-raised focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-raised text-ink-soft">
                  <node.Icon className="h-4 w-4" aria-hidden />
                  <span
                    className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface ${state.dot}`}
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="text-sm font-medium text-ink">
                    {node.label}
                  </span>
                  <span className="mt-0.5 truncate text-xs text-ink-muted">
                    {node.hint}
                  </span>
                </span>
                <span
                  className={`hidden shrink-0 items-center gap-1.5 text-xs font-medium sm:flex ${state.tone}`}
                >
                  <span
                    aria-hidden
                    className={`h-1.5 w-1.5 rounded-full ${state.dot}`}
                  />
                  <span className="max-w-[9rem] truncate">{state.word}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {!interviewerReady && !readinessFailed ? (
        <p className="mt-2 px-1.5 text-xs text-ink-muted">
          The interviewer needs a validated connection — set it up on the
          profile page.
        </p>
      ) : null}
    </section>
  );
}
