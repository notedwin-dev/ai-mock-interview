"use client";

import { Mic, MicOff } from "lucide-react";

/** Shared two-panel voice layout for planning and live interview rooms. */
export function VoiceRoomPanels({
  isAgentSpeaking,
  isUserSpeaking,
  muted,
  caption,
  onToggleMute,
  agentTitle = "AI Interviewer",
  agentState,
  userState,
}: {
  isAgentSpeaking: boolean;
  isUserSpeaking: boolean;
  muted: boolean;
  caption: string;
  onToggleMute: () => void;
  agentTitle?: string;
  agentState?: string;
  userState?: string;
}) {
  const speakingRing = "absolute inset-0 animate-ping rounded-full border-2 border-emerald-400/70";
  const baseAvatar =
    "relative flex h-20 w-20 items-center justify-center rounded-full border text-2xl font-bold transition-colors";

  return (
    <>
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
        <section aria-label="AI interviewer" className="flex min-h-[18rem] flex-col items-center justify-center rounded-3xl border border-line bg-surface p-8 text-center">
          <span className="relative flex h-20 w-20 items-center justify-center">
            {isAgentSpeaking ? <span aria-hidden className={speakingRing} /> : null}
            <span aria-hidden className={`${baseAvatar} ${isAgentSpeaking ? "border-emerald-400 bg-emerald-400/15 text-emerald-300" : "border-line bg-raised text-ink-soft"}`}>
              AI
            </span>
          </span>
          <h2 className="mt-4 text-sm font-semibold text-ink">{agentTitle}</h2>
          <p className="mt-1 text-xs text-ink-muted" role="status" aria-live="polite">
            {agentState ?? (isAgentSpeaking ? "Speaking" : "Listening")}
          </p>
        </section>

        <section aria-label="You" className="flex min-h-[18rem] flex-col items-center justify-center rounded-3xl border border-line bg-surface p-8 text-center">
          <span className="relative flex h-20 w-20 items-center justify-center">
            {isUserSpeaking && !muted ? <span aria-hidden className={speakingRing} /> : null}
            <span aria-hidden className={`${baseAvatar} ${isUserSpeaking && !muted ? "border-emerald-400 bg-emerald-400/15 text-emerald-300" : "border-line bg-raised text-ink-soft"}`}>
              Y
            </span>
          </span>
          <h2 className="mt-4 text-sm font-semibold text-ink">You</h2>
          <p className="mt-1 text-xs text-ink-muted" role="status" aria-live="polite">
            {userState ?? (muted ? "Microphone muted" : isUserSpeaking ? "Speaking" : "Microphone ready")}
          </p>
          <button
            type="button"
            onClick={onToggleMute}
            aria-label="Microphone"
            aria-pressed={muted}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-full border border-line px-4 text-sm text-ink-soft outline-none transition-colors hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-emerald-400">
            {muted ? <MicOff className="h-4 w-4" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
            {muted ? "Unmute" : "Mute"}
          </button>
        </section>
      </div>

      <div className="rounded-2xl border border-line bg-surface px-5 py-4 text-center text-sm text-ink-soft" aria-live="polite">
        {caption}
      </div>
    </>
  );
}
