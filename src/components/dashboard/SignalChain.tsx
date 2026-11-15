import Link from "next/link";
import { AudioLines, Brain, Mic } from "lucide-react";
import type { ProviderConfigSummary } from "@/lib/providers/config";

/**
 * The practice-room console: the candidate's provider pipeline drawn as a
 * patch-bay signal chain (your voice in → the interviewer → voice out). Each
 * node is a real capability configuration state (enabled + credential status,
 * never key material — ADR-0005); the chain conducts end-to-end only when the
 * interviewer (LLM) node is ready, mirroring the session-creation gate
 * (resolveForOutboundCall). On lg the chain becomes a vertical rack unit
 * beside the copy. Green means ready/live; amber needs attention; red is
 * failure only. A server component — links only, no client JS.
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
 * Node state on the dark console panel: lit jade when validated, amber
 * while unvalidated, red after a failed check, dim when nothing is set up.
 */
function nodeState(row: ProviderConfigSummary | null) {
  if (!row) {
    return {
      dot: "bg-stage-muted",
      word: "Not set up",
      tone: "text-stage-muted",
    };
  }
  switch (row.credentialStatus) {
    case "valid":
      return {
        dot: "bg-emerald-400",
        word: row.providerName,
        tone: "text-emerald-300",
      };
    case "unvalidated":
      return {
        dot: "bg-amber-400",
        word: `${row.providerName}, not validated yet`,
        tone: "text-amber-200",
      };
    default:
      return {
        dot: "bg-red-400",
        word: `${row.providerName}, check failed`,
        tone: "text-red-300",
      };
  }
}

const UNKNOWN_STATE = {
  dot: "bg-stage-muted",
  word: "Unknown",
  tone: "text-stage-muted",
} as const;

export function SignalChain({ configurations, readinessFailed }: SignalChainProps) {
  const interviewerReady =
    !readinessFailed && servingRow(configurations, "llm") !== null;
  const conductorReady = (capability: ChainCapability) =>
    interviewerReady && servingRow(configurations, capability) !== null;

  return (
    <section className="rounded-2xl bg-stage p-6 text-stage-text shadow-xl shadow-stage/10 sm:p-8 lg:p-10">
      <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-center lg:gap-16">
        <div>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-stage-text sm:text-4xl">
            Ready for a round?
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-stage-muted sm:text-base">
            {readinessFailed
              ? "Pipeline status could not be loaded. Check back shortly."
              : interviewerReady
                ? "Your signal chain is live. Set the scene, then step into the room."
                : "The interviewer needs a working connection before a session can start."}
          </p>

          <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            {interviewerReady ? (
              <Link
                href="/dashboard/interview/new"
                className="inline-flex h-11 cursor-pointer items-center rounded-lg bg-emerald-400 px-5 text-sm font-semibold text-emerald-950 outline-none transition-all hover:bg-emerald-300 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-emerald-200 focus-visible:ring-offset-2 focus-visible:ring-offset-stage"
              >
                Start a new interview
              </Link>
            ) : (
              <>
                <button
                  type="button"
                  disabled
                  aria-disabled
                  className="inline-flex h-11 cursor-not-allowed items-center rounded-lg bg-stage-raised px-5 text-sm font-semibold text-stage-muted"
                >
                  Start a new interview
                </button>
                {!readinessFailed ? (
                  <Link
                    href="/dashboard/profile"
                    className="text-sm font-medium text-emerald-300 underline decoration-emerald-400/50 underline-offset-4 outline-none transition-colors hover:text-emerald-200 focus-visible:ring-2 focus-visible:ring-emerald-200"
                  >
                    Set up the interviewer connection
                  </Link>
                ) : null}
              </>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-stage-border bg-stage-raised p-3 sm:p-4">
          <ul aria-label="Voice pipeline status" className="flex flex-col">
            {CHAIN_NODES.map((node, index) => {
              const row = servingRow(configurations, node.capability);
              const state = readinessFailed ? UNKNOWN_STATE : nodeState(row);
              const previous = CHAIN_NODES[index - 1];
              const connectorLit =
                previous !== undefined &&
                conductorReady(node.capability) &&
                servingRow(configurations, previous.capability) !== null;
              return (
                <li key={node.capability}>
                  {previous !== undefined ? (
                    <span
                      aria-hidden
                      className={`ml-6 h-4 w-px ${
                        connectorLit ? "bg-emerald-400/70" : "bg-stage-border"
                      }`}
                    />
                  ) : null}
                  <Link
                    href="/dashboard/profile"
                    className="group flex cursor-pointer items-center gap-3 rounded-lg px-1.5 py-2 outline-none transition-colors hover:bg-stage focus-visible:ring-2 focus-visible:ring-emerald-200"
                  >
                    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-stage text-stage-text">
                      <node.Icon className="h-4 w-4" aria-hidden />
                      <span
                        className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-stage-raised ${state.dot}`}
                      />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="text-sm font-medium text-stage-text">
                        {node.label}
                      </span>
                      <span className="mt-0.5 truncate text-xs text-stage-muted">
                        {node.hint}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium">
                      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${state.dot}`} />
                      <span className={`max-w-[9rem] truncate ${state.tone}`}>
                        {state.word}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
