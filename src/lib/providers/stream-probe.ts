/**
 * Bounded WebSocket capability probe (FR-PROVIDER-006, ADR-029).
 *
 * Streaming-capable provider operations are verified over their native
 * WebSocket wire, never over an HTTP stand-in the runtime would not use:
 * - Fish Audio live TTS: `wss://api.fish.audio/v1/tts/live` (Context7-verified
 *   against the official API reference). Bearer key + exact `model` connection
 *   header; frames are MessagePack; a `start` frame with the probe-only text
 *   "ping" is enough to prove the endpoint, credential and exact model.
 * - Google Gemini Live: the same BidiGenerateContent endpoint the app's
 *   streaming ASR adapter uses (`src/lib/ai/live-transcribe.ts`). A JSON
 *   `setup` frame carries the exact configured model.
 * - ElevenLabs Realtime / any minted provider session: the URL and ephemeral
 *   secret returned by `createRealtimeToken` are used verbatim; the provider
 *   key is never handed to the socket layer or returned to the caller.
 *
 * Lifetime rule (owner directive 2026-11-26): every socket opened here is
 * closed before this function resolves or rejects. A hard open/response timeout
 * bounds the handshake, and a short close grace period escalates to
 * `terminate()` so a hung provider can never keep a connection (or the Node
 * event loop) alive indefinitely. No real interview content is ever sent.
 */
import WebSocket from "ws";
import type { ProbeErrorCode } from "./probe";

/** Minimal surface of the Node WebSocket client (`ws`) used by the probe. */
export interface ProbeSocket {
  /** Mutable in fakes; the real WebSocket exposes it as readonly. */
  readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

export type ProbeSocketFactory = (
  url: string,
  options?: { headers?: Record<string, string> },
) => ProbeSocket;

export interface StreamProbeInput {
  url: string;
  /** Connection headers (e.g. Bearer key + exact model header). Never returned. */
  headers?: Record<string, string>;
  /** Frame sent once the socket opens, already serialised by the caller. */
  openFrame?: string | ArrayBuffer | Uint8Array;
  /** Wait for the first provider frame before declaring the probe successful. */
  awaitServerFrame?: boolean;
  /** Hard bound for open + first frame (ms). */
  timeoutMs?: number;
  /** Injectable socket factory so tests never open a real network socket. */
  factory?: ProbeSocketFactory;
}

export type StreamProbeResult =
  | { ok: true; detail: string }
  | { ok: false; errorCode: ProbeErrorCode; detail: string; endpointReachable: boolean };

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CLOSE_GRACE_MS = 1_000;

function defaultFactory(url: string, options?: { headers?: Record<string, string> }): ProbeSocket {
  // Context7-verified (websockets/ws, Fish Audio and OpenAI Realtime docs):
  // Node's global WebSocket follows the WHATWG API and cannot set connection
  // headers, which Fish Audio and the Realtime wire require. The `ws` package
  // accepts `headers`, implements addEventListener and terminate(), and its
  // own closeTimeout is bounded here rather than left at the 30s default.
  const SocketCtor = WebSocket as unknown as new (
    url: string,
    options?: {
      headers?: Record<string, string>;
      closeTimeout?: number;
    },
  ) => ProbeSocket;
  return new SocketCtor(url, {
    ...options,
    closeTimeout: DEFAULT_CLOSE_GRACE_MS,
  });
}

/**
 * Opens one streaming session, optionally sends a single probe frame, waits
 * for the provider, and ALWAYS closes the socket before returning. A failure
 * at any stage is mapped into the probe error taxonomy; no credential is
 * echoed in the returned detail.
 */
export async function probeWebSocketSession(input: StreamProbeInput): Promise<StreamProbeResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const factory = input.factory ?? defaultFactory;

  let socket: ProbeSocket;
  try {
    socket = factory(input.url, input.headers ? { headers: input.headers } : undefined);
  } catch (error) {
    return {
      ok: false,
      errorCode: "network_unreachable",
      detail: error instanceof Error ? error.message : "The streaming endpoint could not be opened.",
      endpointReachable: false,
    };
  }

  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  // Bounded teardown: initiate a normal close, then terminate if the provider
  // has not acknowledged it within the grace period. A pending handshake is
  // aborted immediately with terminate(). The timer is unref'd so it cannot
  // keep the process alive, and cleared as soon as the close event arrives.
  const closeSocket = () => {
    if (socket.readyState === SOCKET_CLOSED) return;
    const onClosed = () => {
      if (closeTimer) clearTimeout(closeTimer);
    };
    socket.addEventListener("close", onClosed);
    if (socket.readyState === SOCKET_CONNECTING) {
      socket.terminate();
      return;
    }
    socket.close(1000, "probe complete");
    closeTimer = setTimeout(() => {
      if (socket.readyState !== SOCKET_CLOSED) socket.terminate();
    }, DEFAULT_CLOSE_GRACE_MS);
    closeTimer.unref?.();
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => done(new Error("The streaming probe timed out.")), timeoutMs);
      timer.unref?.();
      socket.addEventListener("open", () => {
        if (socket.readyState !== SOCKET_OPEN) return;
        if (input.openFrame !== undefined) {
          try {
            socket.send(input.openFrame);
          } catch {
            done(new Error("The streaming provider rejected the probe frame."));
            return;
          }
        }
        if (!input.awaitServerFrame) done();
      });
      socket.addEventListener("message", () => done());
      socket.addEventListener("error", (event) => {
        // Undici attaches the underlying Error to the event; use its sanitized
        // message when present so quota/auth reasons keep their taxonomy.
        const detail =
          (event as { error?: { message?: string } })?.error?.message ??
          (event as { message?: string })?.message ??
          "The streaming provider rejected the WebSocket connection.";
        done(new Error(detail));
      });
      socket.addEventListener("close", () =>
        done(new Error("The streaming provider closed the connection before the probe completed.")),
      );
    });
    return {
      ok: true,
      detail: "Streaming session accepted; no interview content was sent.",
    };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error))
      .replace(/AIza[0-9A-Za-z_-]{10,}/g, "[redacted]")
      .replace(/sk[-_][0-9A-Za-z_-]{8,}/g, "[redacted]")
      .slice(0, 300);
    const timedOut = /timed out/i.test(message);
    const quota = /quota|402|credit|rate[ _-]?limit|resource_exhausted/i.test(message);
    const rejected = /rejected|401|403|unauthor|invalid api key|permission_denied/i.test(message);
    return {
      ok: false,
      errorCode: timedOut
        ? "network_unreachable"
        : quota
          ? "rate_limited"
          : rejected
            ? "authentication_failed"
            : "provider_error",
      detail: message,
      endpointReachable: !timedOut,
    };
  } finally {
    closeSocket();
  }
}

/**
 * Minimal MessagePack encoder for the small Fish Audio TTS/ASR frames. Only
 * maps, strings, booleans, null and non-negative integers are needed; the
 * provider documents `application/msgpack` frames, so a JSON string is not
 * accepted. `sample_rate: 16000` needs uint16, not just positive fixint.
 */
export function encodeMsgpack(value: string | Record<string, unknown>): Uint8Array {
  const bytes: number[] = [];
  const encode = (item: unknown): void => {
    if (typeof item === "string") {
      const utf8 = Buffer.from(item, "utf8");
      if (utf8.length < 32) bytes.push(0xa0 | utf8.length);
      else if (utf8.length < 256) bytes.push(0xd9, utf8.length);
      else bytes.push(0xda, (utf8.length >> 8) & 0xff, utf8.length & 0xff);
      for (const byte of utf8) bytes.push(byte);
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const entries = Object.entries(item);
      // fixmap is enough for these tiny frames (<16 keys).
      bytes.push(0x80 | entries.length);
      for (const [key, child] of entries) {
        encode(key);
        encode(child);
      }
    } else if (typeof item === "number" && Number.isInteger(item) && item >= 0) {
      if (item < 128) bytes.push(item); // positive fixint
      else if (item <= 0xffff) bytes.push(0xcd, (item >> 8) & 0xff, item & 0xff); // uint16
      else bytes.push(0xce, (item >>> 24) & 0xff, (item >>> 16) & 0xff, (item >>> 8) & 0xff, item & 0xff); // uint32
    } else if (typeof item === "boolean") {
      bytes.push(item ? 0xc3 : 0xc2); // true / false
    } else if (item === null) {
      bytes.push(0xc0); // nil
    } else {
      throw new Error("Unsupported probe frame value.");
    }
  };
  encode(value);
  return new Uint8Array(bytes);
}
