"use client";

import { useState } from "react";
import { experimental_useRealtime } from "@ai-sdk/react";
import { google } from "@ai-sdk/google";

/**
 * Bounded retries for persisting one finalized line. The client id is fixed, so
 * every attempt deduplicates server-side against the same transcript row.
 */
const TRANSCRIPT_POST_ATTEMPTS = 3;
/** Statuses that will not heal on retry (the link is gone or already finished). */
const TERMINAL_STATUSES: ReadonlySet<number> = new Set([400, 404, 409]);

interface LiveLine {
  speaker: "candidate" | "interviewer";
  text: string;
  clientId: string;
}

/**
 * Identity tracking for persisted live lines, one registry per token. The
 * realtime callback is recreated on every render (and may fire across room
 * remounts), so identity lives OUTSIDE the component render tree: an id is
 * "saved" only after the transcript route answered 2xx, and "in flight"
 * while a post with the same clientId is still running.
 */
const lineRegistries = new Map<string, { saved: Set<string>; inFlight: Set<string> }>();

function lineRegistry(token: string) {
  const existing = lineRegistries.get(token);
  if (existing) return existing;
  const created = { saved: new Set<string>(), inFlight: new Set<string>() };
  lineRegistries.set(token, created);
  return created;
}


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
  const [failed, setFailed] = useState<LiveLine[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const registry = lineRegistry(token);

  async function post(line: LiveLine): Promise<boolean> {
    for (let attempt = 1; attempt <= TRANSCRIPT_POST_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(
          `/api/v1/interviews/invitations/${encodeURIComponent(token)}/realtime/transcript`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [{
                speaker: line.speaker,
                content: line.text,
                clientId: line.clientId,
              }],
            }),
          },
        );
        if (response.ok) return true;
        // A rejected line (link gone, interview finished, malformed) will not
        // heal on retry; only a transient failure is worth another attempt.
        if (TERMINAL_STATUSES.has(response.status)) return false;
      } catch {
        // Network error: retry below.
      }
    }
    return false;
  }

  /** Persists a finalized line once; an id counts as saved only after a 2xx. */
  async function persist(line: LiveLine) {
    let saved = false;
    try {
      saved = await post(line);
      if (saved) registry.saved.add(line.clientId);
    } finally {
      registry.inFlight.delete(line.clientId);
    }
    if (!saved) {
      setNotice("A transcript line could not be saved; it remains visible here.");
      setFailed((current) => (current.some((l) => l.clientId === line.clientId) ? current : [...current, line]));
    }
  }

  const realtime = experimental_useRealtime({
    model: google.experimental_realtime(modelId),
    api: { token: endpoint },
    sessionConfig: {
      instructions,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      outputModalities: ["audio"],
    },
    onError: () => setNotice("The live session reported an error. Reconnect to try again."),
    onEvent: (event) => {
      const line: LiveLine | null =
        event.type === "input-transcription-completed" && "transcript" in event
          ? { speaker: "candidate", text: String(event.transcript ?? ""), clientId: `in-${event.itemId}` }
          : event.type === "audio-transcript-done" && "transcript" in event
            ? { speaker: "interviewer", text: String(event.transcript ?? ""), clientId: `out-${event.itemId}` }
            : null;
      if (!line || !line.text) return;
      if (registry.saved.has(line.clientId) || registry.inFlight.has(line.clientId)) return;
      registry.inFlight.add(line.clientId);
      setLines((current) => [...current, line]);
      void persist(line);
    },
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
        <p className="text-xs text-amber-300">
          {failed.length} {failed.length === 1 ? "line" : "lines"} not saved yet.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => {
              const retry = failed;
              setFailed([]);
              for (const line of retry) {
                registry.inFlight.add(line.clientId);
                void persist(line);
              }
            }}
          >
            Retry
          </button>
        </p>
      ) : null}
      {notice ? <p className="text-xs text-amber-300">{notice}</p> : null}
    </section>
  );
}
