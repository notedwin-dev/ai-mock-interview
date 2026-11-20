"use client";

import { useState } from "react";
import { experimental_useRealtime } from "@ai-sdk/react";
import { google } from "@ai-sdk/google";

/**
 * Native Gemini Live realtime session for the token-scoped room (ADR-006
 * Option A). WebSocket transport is provided by the AI SDK; the ephemeral
 * client secret is minted by our server route, so the provider key never
 * reaches the browser. Finalized transcript events are persisted to the same
 * chronological transcript as typed turns.
 */
export function LiveVoice({ token, modelId }: { token: string; modelId: string }) {
  const endpoint = `/api/v1/interviews/invitations/${encodeURIComponent(token)}/realtime/token`;
  const [saved] = useState(() => new Set<string>());
  const [liveLines, setLiveLines] = useState<Array<{ speaker: string; text: string }>>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const realtime = experimental_useRealtime({
    model: google.experimental_realtime(modelId),
    api: { token: endpoint },
    sessionConfig: {
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      outputModalities: ["audio"],
    },
    onError: () => setNotice("The live session reported an error. Reconnect to try again."),
    onEvent: (event) => {
      const candidate =
        event.type === "input-transcription-completed" && "transcript" in event
          ? { speaker: "candidate", text: String(event.transcript ?? ""), id: `in-${event.itemId}` }
          : event.type === "audio-transcript-done" && "transcript" in event
            ? { speaker: "interviewer", text: String(event.transcript ?? ""), id: `out-${event.itemId}` }
            : null;
      if (!candidate || !candidate.text || saved.has(candidate.id)) return;
      saved.add(candidate.id);
      setLiveLines((current) => [...current, { speaker: candidate.speaker, text: candidate.text }]);
      void fetch(
        `/api/v1/interviews/invitations/${encodeURIComponent(token)}/realtime/transcript`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{
              speaker: candidate.speaker,
              content: candidate.text,
              clientId: candidate.id,
            }],
          }),
        },
      ).catch(() => setNotice("A transcript line could not be saved; it remains visible here."));
    },
  });

  const connected = realtime.session !== undefined;

  return (
    <section aria-label="Live voice session" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">Live voice (Gemini)</h2>
          <p className="text-xs text-ink-muted">
            {connected ? "Connected — speak naturally" : "Real-time WebSocket session, not started"}
          </p>
        </div>
        {connected ? (
          <button
            type="button"
            onClick={() => void realtime.close()}
            className="inline-flex h-10 items-center rounded-full border border-line px-4 text-sm text-ink-soft"
          >
            End live session
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void realtime.connect()}
            className="inline-flex h-10 items-center rounded-full bg-emerald-400 px-5 text-sm font-semibold text-emerald-950"
          >
            Start live voice
          </button>
        )}
      </div>
      {liveLines.length > 0 ? (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto text-xs">
          {liveLines.map((line, index) => (
            <li key={`${line.speaker}-${index}`}>
              <span className="font-semibold text-ink-soft">{line.speaker}: </span>
              <span className="text-ink">{line.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {notice ? <p className="text-xs text-amber-300">{notice}</p> : null}
    </section>
  );
}
