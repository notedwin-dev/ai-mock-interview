/**
 * Client-side outbox for finalized Gemini Live transcript lines.
 *
 * State is keyed by invitation token and lives OUTSIDE React: the realtime
 * callback is recreated on every render, the room can remount mid-session, and
 * a background drain started by an unmounted instance can still exhaust its
 * retries after a new instance has mounted. Keeping the queue, the saved/in
 * flight identities and the failed lines here means a new mount restores them
 * and every mounted instance observes the outcome of an in-flight drain.
 *
 * Persistence is intentionally fire-and-forget from the event handler: new
 * finalized lines keep arriving while earlier ones are being posted.
 *
 * The queue holds ready lines AND reservations. A completion-signaled
 * interviewer item reserves its chronological position immediately, even
 * though its final delta may still arrive. The drain stops at an unresolved
 * reservation, so a candidate answer finalized later cannot be stored ahead
 * of the question it answers. Ordering an already-populated queue would be too
 * late: the reversal happens when the answer is enqueued, not when it posts.
 *
 * Provider item ids (and candidate transcription chunks) are scoped to a
 * connection generation: Google's mapper restarts its counters per socket and
 * re-emits cumulative candidate text, so only a finalized, connection-scoped
 * item becomes one persisted line.
 */

/** The transcript route validates `content` with `.trim().min(1).max(5000)`. */
export const TRANSCRIPT_SEGMENT_LIMIT = 5000;
/** Bounded retries for one line; its client id never changes between attempts. */
const TRANSCRIPT_POST_ATTEMPTS = 3;
/** Deadline for a single POST. Expiry is a transient failure, retried with the
 * same client id because the server may have committed before the abort.
 * Exported so the timeout test can advance through the real deadline. */
export const TRANSCRIPT_POST_TIMEOUT_MS = 10_000;
/** Statuses that will not heal on retry (the link is gone or already finished). */
const TERMINAL_STATUSES: ReadonlySet<number> = new Set([400, 404, 409]);
/** The transcript route caps client ids at 100 characters. */
const MAX_CLIENT_ID_LENGTH = 100;

const TRANSIENT_NOTICE =
  "A transcript line could not be saved. It has been set aside so later lines continue — retry to save it.";
const TERMINAL_NOTICE =
  "A transcript line was rejected by the server and was not saved. The interview continues with later lines.";

export interface LiveLine {
  speaker: "candidate" | "interviewer";
  text: string;
  clientId: string;
}

/** Immutable view consumed by mounted instances via `useSyncExternalStore`. */
export interface LiveLineStoreSnapshot {
  failed: readonly LiveLine[];
  notice: string | null;
}

const EMPTY_SNAPSHOT: LiveLineStoreSnapshot = { failed: [], notice: null };

type PostResult = "saved" | "rejected" | "unavailable";

/** A ready line, or a chronological slot held open for late interviewer deltas. */
type QueueEntry =
  | { kind: "line"; line: LiveLine }
  | { kind: "reservation"; key: string };

interface OutputReservation {
  key: string;
  itemId: string;
  connection: number;
}

interface LineRegistry {
  saved: Set<string>;
  inFlight: Set<string>;
  /**
   * Base (pre-split) client ids already finalized. Gemini Live re-emits the
   * whole accumulated utterance under one stable item id, so the base id —
   * not a segment id — is the idempotency identity of one logical line.
   */
  bases: Set<string>;
  /**
   * Provider item ids are only unique within one socket: the Google mapper
   * restarts its counters for every connection. Scoping ids with this
   * generation keeps a reused id from suppressing a later utterance.
   */
  connection: number;
  /**
   * Latest cumulative candidate transcript per input item. Google emits one
   * `input-transcription-completed` per text chunk, not one per utterance.
   */
  inputTranscripts: Map<string, { itemId: string; text: string; connection: number }>;
  /**
   * Interviewer items that reported a completion signal but have not been
   * closed yet. Google's mapper emits `audio-transcript-done` on turnComplete
   * yet may deliver a final `audio-transcript-delta` afterwards for the SAME
   * item. Each item holds a reservation in `queue` at its arrival position:
   * late deltas are absorbed into that slot instead of stranding them, and no
   * later line may overtake it while it is still collecting.
   */
  outputReservations: Map<string, OutputReservation>;
  /** Ready lines and unresolved reservations, in chronological order. */
  queue: QueueEntry[];
  /** Transiently failed lines that a user can still retry. */
  failed: LiveLine[];
  notice: string | null;
  draining: boolean;
  listeners: Set<() => void>;
  snapshot: LiveLineStoreSnapshot;
}

const lineRegistries = new Map<string, LineRegistry>();

function lineRegistry(token: string): LineRegistry {
  const existing = lineRegistries.get(token);
  if (existing) return existing;
  const created: LineRegistry = {
    saved: new Set<string>(),
    inFlight: new Set<string>(),
    bases: new Set<string>(),
    connection: 0,
    inputTranscripts: new Map(),
    outputReservations: new Map(),
    queue: [],
    failed: [],
    notice: null,
    draining: false,
    listeners: new Set<() => void>(),
    snapshot: EMPTY_SNAPSHOT,
  };
  lineRegistries.set(token, created);
  return created;
}

/** Publish a fresh snapshot only when failed lines or the notice changed. */
function publish(reg: LineRegistry): void {
  reg.snapshot = { failed: [...reg.failed], notice: reg.notice };
  for (const listener of reg.listeners) listener();
}

export function subscribeLiveLines(token: string, listener: () => void): () => void {
  const reg = lineRegistry(token);
  reg.listeners.add(listener);
  return () => {
    reg.listeners.delete(listener);
  };
}

export function getLiveLineSnapshot(token: string): LiveLineStoreSnapshot {
  return lineRegistry(token).snapshot;
}

/** Stable server snapshot for `useSyncExternalStore` during SSR/hydration. */
export function getServerLiveLineSnapshot(): LiveLineStoreSnapshot {
  return EMPTY_SNAPSHOT;
}

/**
 * The installed `@ai-sdk/google` mapper emits `audio-transcript-done` with no
 * text: the interviewer turn is accumulated from `audio-transcript-delta`
 * events. Deltas are shared by token so a remount mid-turn does not lose them.
 */
const transcriptDeltas = new Map<string, string>();

/**
 * One socket's provider item ids must not mix with another socket's ids, even
 * when a remount or reconnect reuses the same number. The registry lives for
 * the token's lifetime, so this stays consistent across mounts.
 */
export function beginLiveConnection(token: string): void {
  lineRegistry(token).connection += 1;
}

/** Historical ids (no session event) stay unprefixed; later sockets do not. */
function scopedClientId(connection: number, clientId: string): string {
  return connection === 0 ? clientId : `${connection}:${clientId}`;
}

function deltaKey(token: string, itemId: string): string {
  const connection = lineRegistry(token).connection;
  return `${token}\u0000${connection}\u0000${itemId}`;
}

function consumeTranscriptText(key: string): string {
  const text = transcriptDeltas.get(key) ?? "";
  transcriptDeltas.delete(key);
  return text;
}

/**
 * Record an interviewer delta. The mapper rolls to a new synthetic item id
 * only when the next turn's content arrives, so seeing a different item
 * closes any earlier item that already reported completion. Returns lines
 * finalized by that closure (the component displays them).
 */
export function recordTranscriptDelta(token: string, itemId: string, delta: string): LiveLine[] {
  const key = deltaKey(token, itemId);
  const accepted = flushCompletedOutputTranscriptions(token, key);
  if (delta) transcriptDeltas.set(key, (transcriptDeltas.get(key) ?? "") + delta);
  return accepted;
}

/**
 * Signal that an interviewer item reached turnComplete. The item is NOT
 * finalized here: the mapper can still deliver a final delta for it. Instead
 * its chronological slot is reserved NOW, so a candidate answer finalized
 * later is queued behind it and can never be stored ahead of it.
 *
 * Candidate text already collected before this signal belongs to an earlier
 * turn: that interviewer line answers it, so it is queued first. Answers that
 * arrive afterwards stay pending and land behind the reserved question.
 * Repeats for the same item only finalize leftover candidate text.
 */
export function markOutputTranscriptionDone(token: string, itemId: string): LiveLine[] {
  const reg = lineRegistry(token);
  const key = deltaKey(token, itemId);
  const accepted = flushPendingInputTranscripts(token);
  if (reg.outputReservations.has(key)) return accepted;
  reg.outputReservations.set(key, { key, itemId, connection: reg.connection });
  reg.queue.push({ kind: "reservation", key });
  return accepted;
}

/**
 * Close completion-signaled interviewer items by filling their reserved slots
 * with the accumulated text (including deltas that arrived late). The slot was
 * reserved when turnComplete arrived, so the line keeps that position no
 * matter when the last delta lands.
 */
export function flushCompletedOutputTranscriptions(token: string, exceptKey?: string): LiveLine[] {
  const reg = lineRegistry(token);
  const entries = [...reg.outputReservations.values()].filter((r) => r.key !== exceptKey);
  if (entries.length === 0) return [];
  const accepted: LiveLine[] = [];

  for (const reservation of entries) {
    reg.outputReservations.delete(reservation.key);
    const segments = finalizeSegmentsForConnection(reg, {
      speaker: "interviewer",
      text: consumeTranscriptText(reservation.key),
      clientId: `out-${reservation.itemId}`,
    }, reservation.connection);
    // Re-find the slot: candidate inserts above may have shifted its index.
    const index = reg.queue.findIndex(
      (entry) => entry.kind === "reservation" && entry.key === reservation.key,
    );
    if (index >= 0) reg.queue.splice(index, 1);
    accepted.push(...queueSegments(token, segments, index >= 0 ? index : undefined));
  }
  return accepted;
}

/** Flush everything buffered for a token (connection end, close, unmount). */
export function flushPendingLiveLines(token: string): LiveLine[] {
  // Resolving completions also flushes candidate answers that respond to them.
  const closed = flushCompletedOutputTranscriptions(token);
  // Any remaining candidate text belongs to no completion signal and arrives
  // after the last interviewer line.
  return [...closed, ...flushPendingInputTranscripts(token)];
}

/** Consume a turn's accumulated interviewer text; an explicit final text wins. */
export function takeTranscriptText(token: string, itemId: string, finalText?: string): string {
  const key = deltaKey(token, itemId);
  const accumulated = consumeTranscriptText(key);
  return finalText && finalText.length > 0 ? finalText : accumulated;
}

function isSurrogatePairSplit(text: string, index: number): boolean {
  const left = text.charCodeAt(index - 1);
  const right = text.charCodeAt(index);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

/**
 * Split trimmed transcript text into route-sized segments. Boundaries avoid
 * cutting a UTF-16 surrogate pair, and whitespace at a cut is carried into the
 * neighbouring segment instead of being silently discarded.
 */
export function splitFinalizedText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const segments: string[] = [];
  for (let start = 0; start < trimmed.length; ) {
    let end = Math.min(start + TRANSCRIPT_SEGMENT_LIMIT, trimmed.length);
    if (end < trimmed.length && isSurrogatePairSplit(trimmed, end)) end -= 1;
    if (end <= start) end = Math.min(start + TRANSCRIPT_SEGMENT_LIMIT, trimmed.length);
    const segment = trimmed.slice(start, end);
    if (segment.trim()) {
      segments.push(segment);
    } else if (segments.length > 0) {
      segments[segments.length - 1] += segment;
    }
    start = end;
  }
  return segments;
}

/** Derive a distinct, route-valid client id for each segment of one line. */
function segmentClientId(base: string, index: number): string {
  const suffix = `-${index + 1}`;
  return `${base.slice(0, MAX_CLIENT_ID_LENGTH - suffix.length)}${suffix}`;
}

/**
 * Turn one finalized line into route-sized lines. Every segment carries a
 * derived id (even when there is only one) so the id scheme is stable when a
 * longer accumulated transcript later produces more segments.
 */
export function toSegmentLines(line: LiveLine): LiveLine[] {
  return splitFinalizedText(line.text).map((text, index) => ({
    speaker: line.speaker,
    text,
    clientId: segmentClientId(line.clientId, index),
  }));
}

async function post(token: string, line: LiveLine): Promise<PostResult> {
  for (let attempt = 1; attempt <= TRANSCRIPT_POST_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSCRIPT_POST_TIMEOUT_MS);
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
          // Bound each attempt. An aborted request is treated as transient
          // below and retried with the SAME client id: the server may have
          // committed just before the abort, so the id must stay idempotent.
          signal: controller.signal,
        },
      );
      if (response.ok) return "saved";
      // A rejected line (link gone, interview finished, malformed, or a client
      // id reused for different content) will not heal on retry.
      if (TERMINAL_STATUSES.has(response.status)) return "rejected";
    } catch {
      // Network error or deadline expiry: retry below with the same id.
    } finally {
      clearTimeout(timeout);
    }
  }
  return "unavailable";
}

/**
 * Ordered outbox: only the head is posted, and the next line is attempted once
 * that one is acknowledged. An unresolved reservation at the head stops the
 * drain: its late deltas must be absorbed before any later line is stored.
 * A failed head is moved out of the queue rather than left blocking it — a
 * finished link or a temporarily unavailable server must not stop later
 * finalized lines from being persisted. A terminal rejection is dropped with
 * a visible notice; a transient failure is kept in the shared registry so a
 * remounted instance can restore and retry it with its original client id.
 */
export function drainOutbox(token: string): void {
  const reg = lineRegistry(token);
  if (reg.draining) return;
  reg.draining = true;
  void (async () => {
    try {
      while (reg.queue.length > 0) {
        const head = reg.queue[0]!;
        if (head.kind === "reservation") break;
        reg.queue.shift();
        const result = await post(token, head.line);
        if (result === "saved") {
          reg.saved.add(head.line.clientId);
          continue;
        }
        if (result === "rejected") {
          reg.notice = TERMINAL_NOTICE;
        } else {
          if (!reg.failed.some((line) => line.clientId === head.line.clientId)) {
            reg.failed.push(head.line);
          }
          reg.notice = TRANSIENT_NOTICE;
        }
        publish(reg);
      }
    } finally {
      reg.draining = false;
    }
  })();
}

/**
 * Queue route-ready segments, skipping ids already saved or in flight. With a
 * `beforeIndex` the segments replace a closed reservation's slot; otherwise
 * they join the tail. A single splice keeps multi-segment lines contiguous.
 */
function queueSegments(token: string, segments: LiveLine[], beforeIndex?: number): LiveLine[] {
  const reg = lineRegistry(token);
  const accepted: LiveLine[] = [];
  for (const line of segments) {
    if (reg.saved.has(line.clientId) || reg.inFlight.has(line.clientId)) continue;
    reg.inFlight.add(line.clientId);
    accepted.push(line);
  }
  if (accepted.length === 0) return accepted;
  const entries = accepted.map((line) => ({ kind: "line", line }) satisfies QueueEntry);
  if (beforeIndex === undefined) reg.queue.push(...entries);
  else reg.queue.splice(beforeIndex, 0, ...entries);
  drainOutbox(token);
  return accepted;
}

/** Queue route-ready segments at the tail, skipping saved/in-flight ids. */
export function enqueueLiveLines(token: string, lines: LiveLine[]): LiveLine[] {
  return queueSegments(token, lines);
}

/**
 * Split one logical line into route-sized segments for a connection, deduped
 * by base id. Does not touch the queue so a caller can choose its position.
 * An empty array means a repeated/empty transcript: no UI or transcript row.
 */
function finalizeSegmentsForConnection(
  reg: LineRegistry,
  base: LiveLine,
  connection: number,
): LiveLine[] {
  const scoped = { ...base, clientId: scopedClientId(connection, base.clientId) };
  if (reg.bases.has(scoped.clientId)) return [];
  const segments = toSegmentLines(scoped);
  if (segments.length === 0) return [];
  reg.bases.add(scoped.clientId);
  return segments;
}

/** Finalize using the connection generation currently active for the token. */
function enqueueFinalizedForConnection(
  token: string,
  base: LiveLine,
  connection: number,
): LiveLine[] {
  const reg = lineRegistry(token);
  return queueSegments(token, finalizeSegmentsForConnection(reg, base, connection));
}

/** Finalize using the connection generation currently active for the token. */
export function enqueueFinalizedLine(token: string, base: LiveLine): LiveLine[] {
  return enqueueFinalizedForConnection(token, base, lineRegistry(token).connection);
}

function flushPendingInputTranscripts(token: string, exceptKey?: string): LiveLine[] {
  const reg = lineRegistry(token);
  const segments: LiveLine[] = [];
  for (const [key, pending] of reg.inputTranscripts) {
    if (key === exceptKey) continue;
    reg.inputTranscripts.delete(key);
    segments.push(...finalizeSegmentsForConnection(reg, {
      speaker: "candidate",
      text: pending.text,
      clientId: `in-${pending.itemId}`,
    }, pending.connection));
  }
  return queueSegments(token, segments);
}

/**
 * Retain the latest cumulative transcript for one candidate input item.
 * Google emits several `input-transcription-completed` events per utterance,
 * each carrying the text so far; nothing is persisted until the item closes.
 */
export function recordInputTranscription(
  token: string,
  itemId: string,
  transcript: string,
  finished: boolean,
): LiveLine[] {
  const reg = lineRegistry(token);
  const key = `${reg.connection}\u0000${itemId}`;
  // A new item id means the mapper closed the previous utterance: the fallback
  // boundary for payloads that carry no `finished` marker.
  const accepted = flushPendingInputTranscripts(token, key);
  if (finished) {
    const pending = reg.inputTranscripts.get(key);
    reg.inputTranscripts.delete(key);
    accepted.push(...enqueueFinalizedForConnection(token, {
      speaker: "candidate",
      // A textless `finished` event keeps the last cumulative text.
      text: transcript || pending?.text || "",
      clientId: `in-${itemId}`,
    }, reg.connection));
    return accepted;
  }
  reg.inputTranscripts.set(key, { itemId, text: transcript, connection: reg.connection });
  return accepted;
}

/** Close a pending candidate utterance signalled outside a transcription event. */
export function finalizeInputTranscription(token: string): LiveLine[] {
  return flushPendingInputTranscripts(token);
}

/**
 * Retry transiently failed lines with their original client ids (server dedupe
 * applies). Works with no new transcript event, and also while a drain started
 * by an unmounted instance is still running: the active drain picks up what we
 * push. Note that a retried line is stored at its retry position, not its
 * original arrival position — terminal rejections are deliberately NOT
 * retried so they never introduce that reordering.
 */
export function retryFailedLines(token: string): void {
  const reg = lineRegistry(token);
  if (reg.failed.length === 0) return;
  const retry = [...reg.failed];
  reg.failed = [];
  reg.notice = null;
  publish(reg);
  for (const line of retry) reg.queue.push({ kind: "line", line });
  drainOutbox(token);
}
