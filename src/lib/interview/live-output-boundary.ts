/**
 * Google Live output-boundary classification for realtime transcript frames.
 *
 * The pinned mapper emits `audio-transcript-done` only when the turn produced
 * output transcription text, but it emits `waitingForInput` / IDLE signals for
 * every turn completion. Classifying the boundary from the raw frame — on ANY
 * event carrying it, including `response-done` — keeps reserved interviewer
 * lines (and the answers queued behind them) from being stranded when a turn
 * finishes without transcript text.
 *
 * A bare `turnComplete` with no waitingForInput / IDLE signal is deliberately
 * NOT a boundary: the item stays buffered so a final delta arriving after the
 * completion signal can still join the same line.
 */
export function isOutputBoundaryFrame(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const content = (raw as {
    serverContent?: { interactionStatus?: string; waitingForInput?: boolean };
  }).serverContent;
  return content?.interactionStatus === "IDLE" || content?.waitingForInput === true;
}
