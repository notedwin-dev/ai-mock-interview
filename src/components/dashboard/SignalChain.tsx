import Link from "next/link";
import { AudioLines, Brain, Mic } from "lucide-react";
import type { ProviderConfigSummary } from "@/lib/providers/config";

/**
 * The practice-room console: the candidate's provider pipeline drawn as a
 * signal chain (your voice in → the interviewer → voice out). Each node is a
 * real capability configuration state (enabled + credential status, never key
 * material — ADR-0005); the chain conducts end-to-end only when the
 * interviewer (LLM) node is ready, mirroring the session-creation gate
 * (resolveForOutboundCall). A server component — links only, no client JS.
 */

const CHAIN_NODES = [
  { capability: "asr", label: "Your voice", hint: "Microphone input", Icon: Mic },
  { capability: "llm", label: "The interviewer", hint: "AI question and follow-up", Icon: Brain },
  { capability: "tts", label: "Voice out", hint: "Spoken responses", Icon: AudioLines },
] as const;

type ChainCapability = (typeof CHAIN_NODES)[number]["capability"];

interface SignalChainProps {
  configurations: ProviderConfigSummary[];
  readinessFailed: boolean;
}

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
 * Node state on the dark console panel: lit teal when validated, amber while
 * unvalidated, red after a failed check, dim when nothing is configured.
 */
function nodeState(row: ProviderConfigSummary | null) {
  if (!row) return { dot: "bg-stone-600", word: "Not set up", tone: "text-stone-400" };
  switch (row.credentialStatus) {
    case "valid":
      return { dot: "bg-teal-400", word: row.providerName, tone: "text-teal-300" };
    case "unvalidated":
      return {
        dot: "bg-amber-400",
        word: `${row.providerName} unvalidated`,
        tone: "text-amber-200",
      };
    default:
      return {
        dot: "bg-red-400",
        word: `${row.providerName} failed check`,
        tone: "text-red-300",
      };
  }
}

export function SignalChain({ configurations, readinessFailed }: SignalChainProps) {
  const interviewerReady =
    !readinessFailed && servingRow(configurations, "llm") !== null;
  const conductorReady = (capability: ChainCapability) =>
    interviewerReady && servingRow(configurations, capability) !== null;

  return (
    <section className="rounded-2xl bg-stone-900 p-6 text-stone-100 shadow-xl shadow-stone-900/10 sm:p-8 dark:bg-stone-800 dark:shadow-none">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-md">
          <h2 className="font-display text-2xl font-semibold tracking-tight text-stone-50 sm:text-3xl">
            Ready for a round?
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-stone-300">
            {readinessFailed
              ? "Pipeline status could not be loaded. Check back shortly."
              : interviewerReady
                ? "Your signal chain is live. Set the scene, then step into the room."
                : "The interviewer needs a working connection before a session can start."}
          </p>
        </div>

        <ul className="flex flex-wrap items-center gap-x-0 gap-y-3" aria-label="Voice pipeline status">
          {CHAIN_NODES.map((node, index) => {
            const row = servingRow(configurations, node.capability);
            const state = readinessFailed
              ? { dot: "bg-stone-600", word: "Unknown", tone: "text-stone-400" }
              : nodeState(row);
            const previous = CHAIN_NODES[index - 1];
            const connectorLit =
              previous !== undefined && conductorReady(node.capability) && servingRow(configurations, previous.capability) !== null;
            return (
              <li key={node.capability} className="flex items-center gap-3">
                {previous !== undefined ? (
                  <span
                    aria-hidden
                    className={`h-px w-6 sm:w-8 ${connectorLit ? "bg-teal-400/70" : "bg-stone-600"}`}
                  />
                ) : null}
                <Link
                  href="/dashboard/profile"
                  className="group flex cursor-pointer items-center gap-2.5 rounded-full border border-stone-700 bg-stone-800/60 py-2 pl-3 pr-4 outline-none transition-colors hover:border-stone-500 focus-visible:ring-2 focus-visible:ring-teal-300 dark:border-stone-600 dark:bg-stone-900/60"
                >
                  <span className="relative flex h-7 w-7 items-center justify-center rounded-full bg-stone-700/70 text-stone-200 dark:bg-stone-800">
                    <node.Icon className="h-3.5 w-3.5" aria-hidden />
                    <span
                      className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-stone-800 dark:border-stone-900 ${state.dot}`}
                    />
                  </span>
                  <span className="flex flex-col leading-tight">
                    <span className="text-xs font-medium text-stone-100">
                      {node.label}
                    </span>
                    <span className={`text-[11px] ${state.tone}`}>
                      {state.word}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="mt-7 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        {interviewerReady ? (
          <Link
            href="/dashboard/interview/new"
            className="inline-flex h-11 cursor-pointer items-center rounded-lg bg-stone-50 px-5 text-sm font-semibold text-stone-900 outline-none transition-colors hover:bg-white focus-visible:ring-2 focus-visible:ring-teal-300 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900 dark:bg-stone-100 dark:hover:bg-white"
          >
            Start a new interview
          </Link>
        ) : (
          <>
            <button
              type="button"
              disabled
              aria-disabled
              className="inline-flex h-11 cursor-not-allowed items-center rounded-lg bg-stone-700 px-5 text-sm font-semibold text-stone-400 dark:bg-stone-800"
            >
              Start a new interview
            </button>
            {!readinessFailed ? (
              <Link
                href="/dashboard/profile"
                className="text-sm font-medium text-teal-300 underline decoration-teal-500/50 underline-offset-4 outline-none transition-colors hover:text-teal-200 focus-visible:ring-2 focus-visible:ring-teal-300"
              >
                Set up the interviewer connection
              </Link>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
