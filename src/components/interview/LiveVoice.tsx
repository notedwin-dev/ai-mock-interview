"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { experimental_useRealtime } from "@ai-sdk/react";
import { google } from "@ai-sdk/google";
import {
  beginLiveConnection,
  finalizeInputTranscription,
  flushCompletedOutputTranscriptions,
  flushPendingLiveLines,
  getLiveLineSnapshot,
  getServerLiveLineSnapshot,
  markOutputTranscriptionDone,
  recordInputTranscription,
  recordTranscriptDelta,
  retryFailedLines,
  subscribeLiveLines,
  type LiveLine,
} from "@/lib/interview/live-transcript-outbox";

interface GoogleInputTranscription {
  text?: string;
  finished?: boolean;
}

/**
 * The normalized event keeps Google's wire frame in `raw`. The authoritative
 * utterance boundary is `finished` on `inputTranscription`, which may be
 * top-level or nested in `serverContent` depending on the frame.
 */
function inputTranscriptionFrame(raw: unknown): GoogleInputTranscription | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const frame = raw as {
    inputTranscription?: GoogleInputTranscription;
    serverContent?: { inputTranscription?: GoogleInputTranscription };
  };
  return frame.inputTranscription ?? frame.serverContent?.inputTranscription;
}

/** A textless `finished` marker closes the retained cumulative transcript. */
function hasTextlessFinishedMarker(raw: unknown): boolean {
  const frame = inputTranscriptionFrame(raw);
  return frame?.finished === true && !frame.text;
}

/** Google's end-of-turn signals: no more output deltas for this turn. */
function isOutputTurnEnd(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const content = (raw as { serverContent?: { interactionStatus?: string; waitingForInput?: boolean } })
    .serverContent;
  return content?.interactionStatus === "IDLE" || content?.waitingForInput === true;
}

/** turnComplete can share one raw frame with an output boundary signal. */
function hasTurnComplete(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const content = (raw as { serverContent?: { turnComplete?: boolean } }).serverContent;
  return content?.turnComplete === true;
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
  const invitationBase = `/api/v1/interviews/invitations/${encodeURIComponent(token)}`;
  const endpoint = `${invitationBase}/realtime/token`;
  const [lines, setLines] = useState<LiveLine[]>([]);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [captureFailed, setCaptureFailed] = useState(false);
  // Live lines are accepted only for an active interview. Activate through the
  // invitation before connecting, and keep Start unavailable until that
  // succeeds so no socket can be opened while transcript saving would 404.
  const [activation, setActivation] = useState<"checking" | "ready" | "failed">("checking");

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

  const activateInterview = useCallback(async () => {
    setActivation("checking");
    try {
      const response = await fetch(`${invitationBase}/activate`, { method: "POST" });
      if (!response.ok) throw new Error("activation refused");
      setActivation("ready");
      setSessionNotice(null);
    } catch {
      setActivation("failed");
      setSessionNotice(
        "Live voice is unavailable: this interview is not accepting transcript lines. Try again.",
      );
    }
  }, [invitationBase]);

  useEffect(() => {
    // Defer off the effect body: activation updates state before its first
    // await, which an effect must not trigger directly.
    const timer = setTimeout(() => { void activateInterview(); }, 0);
    return () => clearTimeout(timer);
  }, [activateInterview]);

  const handleEvent = useCallback(
    (event: Parameters<NonNullable<Parameters<typeof experimental_useRealtime>[0]["onEvent"]>>[0]) => {
      // Google's mapper restarts its synthetic item ids for every socket, so a
      // reconnect can reuse an id. Close everything buffered by the old socket
      // and move to a new generation before any event of that connection is
      // handled. A successful reconnect also clears a stale warning.
      if (event.type === "session-created") {
        const closed = flushPendingLiveLines(token);
        if (closed.length > 0) setLines((current) => [...current, ...closed]);
        beginLiveConnection(token);
        setSessionNotice(null);
        setCaptureFailed(false);
        return;
      }

      // Input and output transcription have no ordering guarantee. A textless
      // `finished` marker may be attached to ANY event carrying the raw frame
      // (including `response-done`), not just a `custom` event. Close the
      // retained candidate text exactly once (the outbox dedupes repeats) and
      // keep processing the event so interviewer events in the same frame are
      // not skipped.
      if ("raw" in event && hasTextlessFinishedMarker(event.raw)) {
        const closed = finalizeInputTranscription(token);
        if (closed.length > 0) setLines((current) => [...current, ...closed]);
      }

      // turnComplete is not a safe interviewer boundary: Google can deliver
      // the final output delta after it. `audio-transcript-done` only marks the
      // item as completion-signaled; it is closed at the next item boundary or
      // on an explicit end-of-turn signal, so late deltas join the same line.
      if (event.type === "audio-transcript-delta" && "delta" in event) {
        const closed = recordTranscriptDelta(token, event.itemId, String(event.delta ?? ""));
        if (closed.length > 0) setLines((current) => [...current, ...closed]);
        return;
      }

      if (
        event.type === "custom" &&
        "raw" in event &&
        isOutputTurnEnd(event.raw) &&
        // A frame carrying turnComplete too is handled as one boundary by the
        // audio-transcript-done branch below, so no reservation is opened after
        // this boundary has already been processed.
        !hasTurnComplete(event.raw)
      ) {
        const closed = flushCompletedOutputTranscriptions(token);
        if (closed.length > 0) setLines((current) => [...current, ...closed]);
        return;
      }

      // Every input transcription event carries the cumulative text so far.
      // Keep the latest one and enqueue only on its final event.
      if (event.type === "input-transcription-completed" && "itemId" in event && "transcript" in event) {
        const accepted = recordInputTranscription(
          token,
          String(event.itemId),
          String(event.transcript ?? ""),
          "raw" in event ? inputTranscriptionFrame(event.raw)?.finished === true : false,
        );
        if (accepted.length > 0) setLines((current) => [...current, ...accepted]);
        return;
      }

      if (event.type === "audio-transcript-done" && "itemId" in event) {
        // Candidate text already collected before this completion belongs to
        // the previous turn, so it is finalized here, ahead of the question
        // whose slot this event reserves.
        const closed = markOutputTranscriptionDone(token, event.itemId);
        // waitingForInput / IDLE can share this frame with turnComplete. Treat
        // the frame as ONE boundary: reserve and close it in the same handler
        // instead of leaving a reservation created after the flush ran. A bare
        // turnComplete keeps the late-delta path: the slot stays open until the
        // next item or a real output boundary.
        if ("raw" in event && isOutputTurnEnd(event.raw)) {
          closed.push(...flushCompletedOutputTranscriptions(token));
        }
        if (closed.length > 0) setLines((current) => [...current, ...closed]);
      }
    },
    [token],
  );

  // The hook recreates (and disposes) its session when these references
  // change. Model identity and config must depend only on their inputs so a
  // rerender from a status or transcript update cannot drop a live connection.
  const model = useMemo(() => google.experimental_realtime(modelId), [modelId]);
  const sessionConfig = useMemo(
    () => ({
      instructions,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      outputModalities: ["audio"] as ("audio")[],
    }),
    [instructions],
  );

  const realtime = experimental_useRealtime({
    model,
    api: { token: endpoint },
    sessionConfig,
    onError: () => setSessionNotice("The live session reported an error. Reconnect to try again."),
    onEvent: handleEvent,
  });

  const status = realtime.status;
  const connected = status === "connected";
  const busy = status === "connecting" || status === "closing";
  // These actions are memoized once by the SDK, so they stay stable across
  // the status/transcript rerenders that would otherwise recreate callbacks.
  const { connect: connectSession, close: closeSession, resumeAudioCapture } = realtime;

  const requestCapture = useCallback(async () => {
    try {
      // The installed Google model is turn-based over a client-secret socket,
      // so the SDK does NOT acquire the microphone automatically. Start it
      // only now that the socket is ready.
      await resumeAudioCapture();
      setCaptureFailed(false);
      setSessionNotice(null);
    } catch {
      setCaptureFailed(true);
      setSessionNotice("Microphone access is required. Allow it and retry, or end the live session.");
    }
  }, [resumeAudioCapture]);

  useEffect(() => {
    if (status !== "connected") return;
    // Defer off the effect body: capture may synchronously resolve its state
    // update, which an effect must not trigger directly.
    const timer = setTimeout(() => { void requestCapture(); }, 0);
    return () => clearTimeout(timer);
  }, [status, requestCapture]);

  const endSession = useCallback(() => {
    const closed = flushPendingLiveLines(token);
    if (closed.length > 0) setLines((current) => [...current, ...closed]);
    setCaptureFailed(false);
    void closeSession();
  }, [token, closeSession]);

  // A remount (or tab close) must not strand interviewer text that was still
  // waiting for a late delta or a next-item boundary.
  useEffect(() => () => {
    flushPendingLiveLines(token);
  }, [token]);

  return (
    <section aria-label="Live voice session" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">Live voice</h2>
          <p className="text-xs text-ink-muted">
            {connected
              ? "Connected — speak naturally"
              : busy
                ? "Connecting…"
                : status === "error"
                  ? "Disconnected — reconnect to try again"
                  : "Real-time WebSocket session, not started"}
          </p>
        </div>
        {connected ? (
          <button
            type="button"
            onClick={endSession}
            className="inline-flex h-10 items-center rounded-full border border-line px-4 text-sm text-ink-soft"
          >
            End live session
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (activation === "ready") void connectSession();
            }}
            disabled={busy || activation !== "ready"}
            className="inline-flex h-10 items-center rounded-full bg-emerald-400 px-5 text-sm font-semibold text-emerald-950 disabled:opacity-50"
          >
            {activation === "ready"
              ? "Start live voice"
              : activation === "failed"
                ? "Live voice unavailable"
                : "Preparing live voice…"}
          </button>
        )}
      </div>
      {activation === "failed" && !connected ? (
        <button
          type="button"
          className="self-start text-xs text-amber-300 underline"
          onClick={() => void activateInterview()}
        >
          Retry activation
        </button>
      ) : null}
      {connected && captureFailed ? (
        <button
          type="button"
          onClick={() => void requestCapture()}
          className="self-start text-xs text-amber-300 underline"
        >
          Retry microphone
        </button>
      ) : null}
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
