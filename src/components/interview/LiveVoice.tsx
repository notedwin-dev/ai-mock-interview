"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { experimental_useRealtime } from "@ai-sdk/react";
import { google } from "@ai-sdk/google";
import {
  enqueueFinalizedLine,
  getLiveLineSnapshot,
  getServerLiveLineSnapshot,
  recordTranscriptDelta,
  retryFailedLines,
  subscribeLiveLines,
  takeTranscriptText,
  type LiveLine,
} from "@/lib/interview/live-transcript-outbox";

/**
 * Native Gemini Live realtime session for the token-scoped room (ADR-006
 * Option A). WebSocket transport is provided by the AI SDK; the ephemeral
 * client secret is minted by our server route, so the provider key never
 * reaches the browser. Finalized transcript events are persisted to the same
 * chronological transcript as typed turns.
 *
 * The session config (instructions + transcription + audio modalities) is
 * built ONCE server-side from the interview context and passed as a prop:
 * the AI SDK delivers it both through the token request (baked into Google's
 * client secret) and as a `session-update` over the WebSocket, so both paths
 * carry the identical configuration (verified in the AI SDK source).
 *
 * Outbox identity, failures and background persistence live in the shared
 * per-token registry (see live-transcript-outbox.ts), not in this component:
 * an instance that unmounts mid-drain must not take the retry state with it.
 */
export function LiveVoice({
  token,
  modelId,
  instructions,
}: {
  token: string;
  modelId: string;
  instructions: string;
}) {
  const endpoint = `/api/v1/interviews/invitations/${encodeURIComponent(token)}/realtime/token`;
  const [lines, setLines] = useState<LiveLine[]>([]);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  // Restores failed lines on mount and keeps every mounted instance in sync
  // with a drain that was started (and may exhaust) in a previous instance.
  const subscribe = useCallback(
    (onChange: () => void) => subscribeLiveLines(token, onChange),
    [token],
  );
  const getSnapshot = useCallback(() => getLiveLineSnapshot(token), [token]);
  const { failed, notice: outboxNotice } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerLiveLineSnapshot,
  );
  const retry = useCallback(() => retryFailedLines(token), [token]);

  const handleEvent = useCallback(
    (event: Parameters<NonNullable<Parameters<typeof experimental_useRealtime>[0]["onEvent"]>>[0]) => {
      // The installed Google mapper emits interviewer text as deltas and a
      // textless `audio-transcript-done`; accumulate until the turn closes.
      if (event.type === "audio-transcript-delta" && "delta" in event) {
        recordTranscriptDelta(token, event.itemId, String(event.delta ?? ""));
        return;
      }
      const line: LiveLine | null =
        event.type === "input-transcription-completed" && "transcript" in event
          ? { speaker: "candidate", text: String(event.transcript ?? ""), clientId: `in-${event.itemId}` }
          : event.type === "audio-transcript-done" && "itemId" in event
            ? {
                speaker: "interviewer",
                text: takeTranscriptText(
                  token,
                  event.itemId,
                  "transcript" in event ? String(event.transcript ?? "") : undefined,
                ),
                clientId: `out-${event.itemId}`,
              }
            : null;
      if (!line) return;

      // Split long turns (and dedupe accumulated re-deliveries) before
      // queueing; enqueueFinalizedLine starts background persistence.
      const accepted = enqueueFinalizedLine(token, line);
      if (accepted.length > 0) setLines((current) => [...current, ...accepted]);
    },
    [token],
  );

  const realtime = experimental_useRealtime({
    model: google.experimental_realtime(modelId),
    api: { token: endpoint },
    sessionConfig: {
      instructions,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      outputModalities: ["audio"],
    },
    onError: () => setSessionNotice("The live session reported an error. Reconnect to try again."),
    onEvent: handleEvent,
  });

  const connected = realtime.session !== undefined;

  return (
    <section aria-label="Live voice session" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">Live voice</h2>
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
      {lines.length > 0 ? (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto text-xs">
          {lines.map((line) => (
            <li key={line.clientId}>
              <span className="font-semibold text-ink-soft">{line.speaker}: </span>
              <span className="text-ink">{line.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {failed.length > 0 ? (
        <div className="flex flex-col gap-1 text-xs text-amber-300">
          <p>
            {failed.length} {failed.length === 1 ? "line" : "lines"} not saved yet.{" "}
            <button type="button" className="underline" onClick={retry}>
              Retry
            </button>
          </p>
          <ul className="max-h-20 overflow-y-auto">
            {failed.map((line) => (
              <li key={line.clientId}>
                <span className="font-semibold">{line.speaker}: </span>
                {line.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {outboxNotice ? <p className="text-xs text-amber-300">{outboxNotice}</p> : null}
      {sessionNotice ? <p className="text-xs text-amber-300">{sessionNotice}</p> : null}
    </section>
  );
}
