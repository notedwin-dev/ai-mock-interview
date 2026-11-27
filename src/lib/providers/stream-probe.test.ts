import { describe, expect, it } from "vitest";
import {
  encodeMsgpack,
  probeWebSocketSession,
  type ProbeSocket,
  type ProbeSocketFactory,
} from "./stream-probe";

/**
 * Unit tests for the bounded WebSocket probe (owner directive 2026-11-26):
 * streaming-capable capabilities are probed over WSS and the connection must
 * never be left running after the probe finishes. All sockets here are fakes.
 */
class FakeSocket implements ProbeSocket {
  readyState = 0;
  sent: unknown[] = [];
  closedWith: "close" | "terminate" | null = null;
  private readonly listeners = new Map<string, Array<() => void>>();

  send(data: string | ArrayBuffer | Uint8Array) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = "close";
    this.emit("close");
  }

  terminate() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = "terminate";
    this.emit("close");
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as () => void);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry !== listener),
    );
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  message() {
    this.emit("message");
  }

  error() {
    this.emit("error");
  }
}

describe("probeWebSocketSession", () => {
  it("validates a streaming session and closes the socket before returning", async () => {
    const socket = new FakeSocket();
    const factory: ProbeSocketFactory = () => socket;
    queueMicrotask(() => {
      socket.open();
      socket.message();
    });

    const result = await probeWebSocketSession({
      url: "wss://provider.example/stream",
      headers: { Authorization: "Bearer probe-key", model: "exact-model" },
      factory,
    });

    expect(result).toMatchObject({ ok: true });
    expect(socket.readyState).toBe(3);
    expect(socket.closedWith).toBe("close");
  });

  it("sends the caller's probe frame once the socket opens", async () => {
    const socket = new FakeSocket();
    queueMicrotask(() => {
      socket.open();
      socket.message();
    });

    await probeWebSocketSession({
      url: "wss://provider.example/stream",
      openFrame: '{"setup":{"model":"models/exact"}}',
      factory: () => socket,
    });

    expect(socket.sent).toEqual(['{"setup":{"model":"models/exact"}}']);
  });

  it("closes the socket when the provider never answers, with a bounded timeout", async () => {
    const socket = new FakeSocket();
    queueMicrotask(() => socket.open());

    const result = await probeWebSocketSession({
      url: "wss://provider.example/stream",
      awaitServerFrame: true,
      timeoutMs: 25,
      factory: () => socket,
    });

    expect(result).toMatchObject({ ok: false, errorCode: "network_unreachable" });
    expect(socket.readyState).toBe(3);
    expect(socket.closedWith).toBe("close");
  });

  it("terminates a socket that fails while still connecting", async () => {
    const socket = new FakeSocket();
    queueMicrotask(() => socket.error());

    const result = await probeWebSocketSession({
      url: "wss://provider.example/stream",
      factory: () => socket,
    });

    expect(result).toMatchObject({ ok: false, errorCode: "authentication_failed" });
    expect(socket.readyState).toBe(3);
    expect(socket.closedWith).toBe("terminate");
  });

  it("maps an early provider close to a failed probe and leaves the socket closed", async () => {
    const socket = new FakeSocket();
    queueMicrotask(() => socket.close());

    const result = await probeWebSocketSession({
      url: "wss://provider.example/stream",
      factory: () => socket,
    });

    expect(result).toMatchObject({ ok: false, errorCode: "provider_error" });
    expect(socket.readyState).toBe(3);
  });
});

describe("encodeMsgpack", () => {
  it("encodes the Fish Audio start frame as a MessagePack map of strings", () => {
    const frame = encodeMsgpack({ event: "start", request: { text: "ping", format: "mp3" } });
    expect(Array.from(frame.slice(0, 6))).toEqual([
      0x82, 0xa5, 0x65, 0x76, 0x65, 0x6e,
    ]); // fixmap(2), fixstr(5), "e","v","e","n"
    expect(Buffer.from(frame).toString("hex")).toContain(
      Buffer.from("start", "utf8").toString("hex"),
    );
  });
});
