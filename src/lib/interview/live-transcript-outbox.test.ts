import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginLiveConnection,
  enqueueFinalizedLine,
  finalizeInputTranscription,
  flushCompletedOutputTranscriptions,
  getLiveLineSnapshot,
  markOutputTranscriptionDone,
  recordInputTranscription,
  recordTranscriptDelta,
  retryFailedLines,
  splitFinalizedText,
  subscribeLiveLines,
  takeTranscriptText,
  toSegmentLines,
  TRANSCRIPT_SEGMENT_LIMIT,
  type LiveLine,
} from "./live-transcript-outbox";

const fetchMock = vi.fn();
let tokenCounter = 0;
function token(): string {
  return `outbox-token-${++tokenCounter}`;
}
function ok(): Response {
  return new Response(null, { status: 200 });
}
function status(code: number): Response {
  return new Response(null, { status: code });
}
function postedClientIds(): string[] {
  return fetchMock.mock.calls.map((call) => {
    const body = JSON.parse(String(call[1]?.body)) as {
      messages: Array<{ clientId: string }>;
    };
    return body.messages[0]!.clientId;
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("finalized transcript segmentation", () => {
  it("splits over-limit text into route-sized segments without losing content", () => {
    const text = "a".repeat(TRANSCRIPT_SEGMENT_LIMIT * 2 + 2000);
    const segments = splitFinalizedText(text);

    expect(segments.map((segment) => segment.length)).toEqual([
      TRANSCRIPT_SEGMENT_LIMIT,
      TRANSCRIPT_SEGMENT_LIMIT,
      2000,
    ]);
    expect(segments.join("")).toBe(text);
    for (const segment of segments) {
      expect(segment.trim().length).toBeLessThanOrEqual(TRANSCRIPT_SEGMENT_LIMIT);
    }
  });

  it("keeps whitespace that lands on a segment boundary", () => {
    const trailing = "a".repeat(TRANSCRIPT_SEGMENT_LIMIT - 1) + " " + "b".repeat(TRANSCRIPT_SEGMENT_LIMIT + 1);
    const leading = "a".repeat(TRANSCRIPT_SEGMENT_LIMIT) + " " + "b".repeat(TRANSCRIPT_SEGMENT_LIMIT);

    expect(splitFinalizedText(trailing).join("")).toBe(trailing);
    expect(splitFinalizedText(leading).join("")).toBe(leading);
  });

  it("keeps an in-limit line whole and discards whitespace-only text", () => {
    const text = "b".repeat(TRANSCRIPT_SEGMENT_LIMIT);
    expect(splitFinalizedText(`  ${text}  `)).toEqual([text]);
    expect(splitFinalizedText("   ")).toEqual([]);
  });

  it("does not split a surrogate pair at a segment boundary", () => {
    const text = "x".repeat(TRANSCRIPT_SEGMENT_LIMIT - 1) + "😀" + "y".repeat(TRANSCRIPT_SEGMENT_LIMIT + 1);
    const segments = splitFinalizedText(text);
    const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
    const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

    expect(segments.join("")).toBe(text);
    for (const segment of segments) {
      expect(isHigh(segment.charCodeAt(segment.length - 1))).toBe(false);
      expect(isLow(segment.charCodeAt(0))).toBe(false);
    }
  });

  it("derives distinct, route-valid client ids for every segment", () => {
    const long: LiveLine = {
      speaker: "candidate",
      text: "a".repeat(TRANSCRIPT_SEGMENT_LIMIT * 2 + 1),
      clientId: "in-item-7",
    };
    const segments = toSegmentLines(long);
    expect(segments.map((line) => line.clientId)).toEqual(["in-item-7-1", "in-item-7-2", "in-item-7-3"]);
    expect(segments.map((line) => line.speaker)).toEqual(["candidate", "candidate", "candidate"]);
    expect(segments.map((line) => line.text).join("")).toBe(long.text);

    const single = toSegmentLines({ speaker: "interviewer", text: "hello", clientId: "out-1" });
    expect(single).toEqual([{ speaker: "interviewer", text: "hello", clientId: "out-1-1" }]);

    const veryLongBase = "i".repeat(120);
    const ids = toSegmentLines({ ...long, clientId: veryLongBase }).map((line) => line.clientId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(100);
  });
});

describe("interviewer transcript accumulation", () => {
  it("assembles deltas into one finalized turn and prefers an explicit final text", () => {
    const t = token();
    recordTranscriptDelta(t, "google-item-1", "Hello ");
    recordTranscriptDelta(t, "google-item-1", "world.");
    expect(takeTranscriptText(t, "google-item-1")).toBe("Hello world.");
    expect(takeTranscriptText(t, "google-item-1")).toBe("");

    recordTranscriptDelta(t, "google-item-2", "partial");
    expect(takeTranscriptText(t, "google-item-2", "final")).toBe("final");
  });
});

describe("interviewer output completion boundary", () => {
  it("finalizes one interviewer line when the final delta precedes turnComplete", async () => {
    const t = token();
    fetchMock.mockResolvedValue(ok());
    beginLiveConnection(t);

    recordTranscriptDelta(t, "google-item-0", "Hello ");
    recordTranscriptDelta(t, "google-item-0", "world.");
    markOutputTranscriptionDone(t, "google-item-0");

    expect(flushCompletedOutputTranscriptions(t)).toEqual([
      { speaker: "interviewer", text: "Hello world.", clientId: "1:out-google-item-0-1" },
    ]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0]!.content).toBe("Hello world.");
  });

  it("includes a final delta that arrives after turnComplete in the same line", async () => {
    const t = token();
    fetchMock.mockResolvedValue(ok());
    beginLiveConnection(t);

    recordTranscriptDelta(t, "google-item-0", "Hello ");
    markOutputTranscriptionDone(t, "google-item-0");
    // Google delivers output transcription independently: the final chunk may
    // arrive after the completion signal for the SAME item id.
    recordTranscriptDelta(t, "google-item-0", "world.");

    expect(flushCompletedOutputTranscriptions(t)).toEqual([
      { speaker: "interviewer", text: "Hello world.", clientId: "1:out-google-item-0-1" },
    ]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(postedClientIds()).toEqual(["1:out-google-item-0-1"]);
  });

  it("closes a completion-signaled item when a new interviewer item starts", async () => {
    const t = token();
    fetchMock.mockResolvedValue(ok());
    beginLiveConnection(t);

    recordTranscriptDelta(t, "google-item-0", "first question");
    markOutputTranscriptionDone(t, "google-item-0");
    expect(recordTranscriptDelta(t, "google-item-1", "next ")).toEqual([
      { speaker: "interviewer", text: "first question", clientId: "1:out-google-item-0-1" },
    ]);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(postedClientIds()).toEqual(["1:out-google-item-0-1"]);
  });

  it("queues a retained candidate answer before the interviewer line answering it", async () => {
    const t = token();
    fetchMock.mockResolvedValue(ok());
    beginLiveConnection(t);

    // The candidate's final text is retained but has not been queued yet; the
    // interviewer line completes first (no ordering guarantee between streams).
    recordInputTranscription(t, "google-input-0", "my answer", false);
    recordTranscriptDelta(t, "google-item-0", "Tell me more.");
    markOutputTranscriptionDone(t, "google-item-0");

    const closed = flushCompletedOutputTranscriptions(t);
    expect(closed.map((line) => line.speaker)).toEqual(["candidate", "interviewer"]);
    expect(closed.map((line) => line.clientId)).toEqual([
      "1:in-google-input-0-1",
      "1:out-google-item-0-1",
    ]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(postedClientIds()).toEqual(["1:in-google-input-0-1", "1:out-google-item-0-1"]);
  });
});

describe("live transcript outbox", () => {
  it("posts queued lines in arrival order with stable ids and deduplicates replays", async () => {
    const t = token();
    fetchMock.mockResolvedValue(ok());
    const first: LiveLine = { speaker: "candidate", text: "one", clientId: "in-1" };
    const second: LiveLine = { speaker: "interviewer", text: "two", clientId: "out-2" };

    expect(enqueueFinalizedLine(t, first)).toEqual([{ ...first, clientId: "in-1-1" }]);
    expect(enqueueFinalizedLine(t, second)).toEqual([{ ...second, clientId: "out-2-1" }]);
    expect(enqueueFinalizedLine(t, first)).toEqual([]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(postedClientIds()).toEqual(["in-1-1", "out-2-1"]);
    expect(getLiveLineSnapshot(t)).toEqual({ failed: [], notice: null });
  });

  it("does not duplicate an accumulated candidate utterance re-sent under one item id", async () => {
    const t = token();
    fetchMock.mockResolvedValue(ok());
    const base = { speaker: "candidate" as const, clientId: "in-google-input-0" };

    expect(enqueueFinalizedLine(t, { ...base, text: "short fragment" })).toHaveLength(1);
    expect(enqueueFinalizedLine(t, { ...base, text: "short fragment and much more text" })).toEqual([]);
    expect(enqueueFinalizedLine(t, {
      ...base,
      text: "a".repeat(TRANSCRIPT_SEGMENT_LIMIT * 2 + 1),
    })).toEqual([]);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("posts each split segment as a separate idempotent message", async () => {
    const t = token();
    fetchMock.mockResolvedValue(ok());
    enqueueFinalizedLine(t, {
      speaker: "candidate",
      text: "a".repeat(TRANSCRIPT_SEGMENT_LIMIT * 2 + 1),
      clientId: "in-long",
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(postedClientIds()).toEqual(["in-long-1", "in-long-2", "in-long-3"]);
  });

  it("drops a permanently rejected line with a notice so later lines are not blocked", async () => {
    const t = token();
    fetchMock.mockResolvedValueOnce(status(404)).mockResolvedValue(ok());
    enqueueFinalizedLine(t, { speaker: "candidate", text: "gone", clientId: "in-1" });
    enqueueFinalizedLine(t, { speaker: "interviewer", text: "next", clientId: "out-2" });
    enqueueFinalizedLine(t, { speaker: "candidate", text: "next again", clientId: "in-3" });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    expect(getLiveLineSnapshot(t).failed).toEqual([]);
    expect(getLiveLineSnapshot(t).notice).toContain("rejected");
    expect(postedClientIds()).toEqual(["in-1-1", "out-2-1", "in-3-1"]);
  });

  it("does not waste retries on a terminal rejection", async () => {
    const t = token();
    fetchMock.mockResolvedValue(status(400));
    enqueueFinalizedLine(t, { speaker: "candidate", text: "malformed", clientId: "in-1" });

    await vi.waitFor(() => expect(getLiveLineSnapshot(t).notice).toContain("rejected"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getLiveLineSnapshot(t).failed).toEqual([]);
  });

  it("retries transiently failed lines with their original ids without a new transcript line", async () => {
    const t = token();
    fetchMock
      .mockResolvedValueOnce(status(500))
      .mockResolvedValueOnce(status(500))
      .mockResolvedValueOnce(status(500))
      .mockResolvedValue(ok());
    enqueueFinalizedLine(t, { speaker: "candidate", text: "transient", clientId: "in-1" });

    await vi.waitFor(() => expect(getLiveLineSnapshot(t).failed).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    retryFailedLines(t);
    await vi.waitFor(() => expect(getLiveLineSnapshot(t).failed).toHaveLength(0));

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(postedClientIds()).toEqual(["in-1-1", "in-1-1", "in-1-1", "in-1-1"]);
    expect(getLiveLineSnapshot(t)).toEqual({ failed: [], notice: null });
  });

  it("retries several set-aside lines together in their original order", async () => {
    const t = token();
    fetchMock.mockResolvedValue(status(500));
    enqueueFinalizedLine(t, { speaker: "candidate", text: "first", clientId: "in-a" });
    await vi.waitFor(() => expect(getLiveLineSnapshot(t).failed).toHaveLength(1));
    enqueueFinalizedLine(t, { speaker: "interviewer", text: "second", clientId: "out-b" });
    await vi.waitFor(() => expect(getLiveLineSnapshot(t).failed).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(6);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(ok());
    retryFailedLines(t);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(postedClientIds()).toEqual(["in-a-1", "out-b-1"]);
    expect(getLiveLineSnapshot(t)).toEqual({ failed: [], notice: null });
  });

  it("picks up a retry issued while another instance's drain is still in flight", async () => {
    const t = token();
    fetchMock.mockResolvedValue(status(500));
    enqueueFinalizedLine(t, { speaker: "candidate", text: "failed", clientId: "in-f" });
    await vi.waitFor(() => expect(getLiveLineSnapshot(t).failed).toHaveLength(1));

    fetchMock.mockReset();
    let resolveCurrent!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveCurrent = resolve;
    }));
    fetchMock.mockResolvedValue(ok());

    enqueueFinalizedLine(t, { speaker: "interviewer", text: "current", clientId: "out-b" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    retryFailedLines(t);
    expect(getLiveLineSnapshot(t).failed).toEqual([]);

    resolveCurrent(ok());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(postedClientIds()).toEqual(["out-b-1", "in-f-1"]);
  });

  it("restores a failed line on a new mount and observes a drain that exhausts after unmount", async () => {
    const t = token();
    let resolvePost!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolvePost = resolve;
    }));
    fetchMock.mockResolvedValue(status(500));

    const unmounted = vi.fn();
    const unsubscribeOld = subscribeLiveLines(t, unmounted);
    enqueueFinalizedLine(t, { speaker: "candidate", text: "late failure", clientId: "in-1" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    unsubscribeOld();

    // A new instance mounts while the old instance's drain is still in flight.
    const mounted = vi.fn();
    const unsubscribeNew = subscribeLiveLines(t, mounted);
    expect(getLiveLineSnapshot(t).failed).toEqual([]);

    resolvePost(status(500));
    await vi.waitFor(() => expect(getLiveLineSnapshot(t).failed).toHaveLength(1));

    expect(mounted).toHaveBeenCalled();
    expect(unmounted).not.toHaveBeenCalled();
    unsubscribeNew();

    // No further transcript event: the restored line is still retryable.
    const restored = getLiveLineSnapshot(t);
    expect(restored.failed.map((line) => line.clientId)).toEqual(["in-1-1"]);
    expect(restored.notice).toContain("retry");

    fetchMock.mockResolvedValue(ok());
    retryFailedLines(t);
    await vi.waitFor(() => expect(getLiveLineSnapshot(t).failed).toHaveLength(0));
    expect(postedClientIds().slice(-1)).toEqual(["in-1-1"]);
  });
});

describe("bounded transcript POST", () => {
  it("passes an abort signal to fetch and retries an aborted attempt with the same client id", async () => {
    const t = token();
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url, init) => {
      const signal = init.signal as AbortSignal;
      signals.push(signal);
      return signals.length === 1
        ? new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("deadline expired")), { once: true });
          })
        : Promise.resolve(ok());
    });

    enqueueFinalizedLine(t, { speaker: "candidate", text: "saved after abort", clientId: "in-abort" });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]).toBeInstanceOf(AbortSignal);

    // Simulate the deadline expiring while the first POST is in flight.
    signals[0]!.dispatchEvent(new Event("abort"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(postedClientIds()).toEqual(["in-abort-1", "in-abort-1"]);
    expect(getLiveLineSnapshot(t)).toEqual({ failed: [], notice: null });
  });
});

describe("provider item identity across connections", () => {
  it("accepts a reused item id on a new connection but dedupes replays within one", async () => {
    const t = token();
    fetchMock.mockResolvedValue(ok());
    beginLiveConnection(t);
    expect(enqueueFinalizedLine(t, {
      speaker: "candidate",
      text: "first connection",
      clientId: "in-google-input-0",
    })).toEqual([{ speaker: "candidate", text: "first connection", clientId: "1:in-google-input-0-1" }]);
    expect(enqueueFinalizedLine(t, {
      speaker: "candidate",
      text: "replayed",
      clientId: "in-google-input-0",
    })).toEqual([]);

    // Google's mapper restarts its ids on the new socket.
    beginLiveConnection(t);
    expect(enqueueFinalizedLine(t, {
      speaker: "candidate",
      text: "second connection",
      clientId: "in-google-input-0",
    })).toEqual([{ speaker: "candidate", text: "second connection", clientId: "2:in-google-input-0-1" }]);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(postedClientIds()).toEqual(["1:in-google-input-0-1", "2:in-google-input-0-1"]);
    const contents = fetchMock.mock.calls.map((call) =>
      (JSON.parse(String(call[1]?.body)) as {
        messages: Array<{ content: string }>;
      }).messages[0]!.content,
    );
    expect(contents).toEqual(["first connection", "second connection"]);
  });

  it("scopes interviewer ids too and keeps retry recovery across reconnects", async () => {
    const t = token();
    fetchMock.mockResolvedValue(ok());
    beginLiveConnection(t);
    expect(enqueueFinalizedLine(t, {
      speaker: "interviewer",
      text: "hello",
      clientId: "out-google-item-0",
    })).toEqual([{ speaker: "interviewer", text: "hello", clientId: "1:out-google-item-0-1" }]);
    beginLiveConnection(t);
    expect(enqueueFinalizedLine(t, {
      speaker: "interviewer",
      text: "hello again",
      clientId: "out-google-item-0",
    })).toEqual([{ speaker: "interviewer", text: "hello again", clientId: "2:out-google-item-0-1" }]);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(postedClientIds()).toEqual(["1:out-google-item-0-1", "2:out-google-item-0-1"]);
  });
});

describe("candidate input transcription", () => {
  it("persists only the final cumulative transcript once per input item", async () => {
    const t = token();
    fetchMock.mockResolvedValue(ok());
    beginLiveConnection(t);

    expect(recordInputTranscription(t, "google-input-0", "Hello ", false)).toEqual([]);
    expect(recordInputTranscription(t, "google-input-0", "Hello world", false)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    expect(recordInputTranscription(t, "google-input-0", "Hello world.", true)).toEqual([
      { speaker: "candidate", text: "Hello world.", clientId: "1:in-google-input-0-1" },
    ]);
    expect(recordInputTranscription(t, "google-input-0", "Hello world.", true)).toEqual([]);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(postedClientIds()).toEqual(["1:in-google-input-0-1"]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0]!.content).toBe("Hello world.");
  });

  it("closes the previous item on a fallback boundary with no finished marker", async () => {
    const t = token();
    fetchMock.mockResolvedValue(ok());
    beginLiveConnection(t);

    expect(recordInputTranscription(t, "google-input-0", "first utterance", false)).toEqual([]);
    expect(recordInputTranscription(t, "google-input-1", "second ", false)).toEqual([
      { speaker: "candidate", text: "first utterance", clientId: "1:in-google-input-0-1" },
    ]);
    expect(recordInputTranscription(t, "google-input-1", "second utterance", true)).toEqual([
      { speaker: "candidate", text: "second utterance", clientId: "1:in-google-input-1-1" },
    ]);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(postedClientIds()).toEqual(["1:in-google-input-0-1", "1:in-google-input-1-1"]);
  });

  it("keeps the retained text when a textless finished marker closes the item", async () => {
    const t = token();
    fetchMock.mockResolvedValue(ok());
    beginLiveConnection(t);

    expect(recordInputTranscription(t, "google-input-0", "cumulative answer", false)).toEqual([]);
    expect(finalizeInputTranscription(t)).toEqual([
      { speaker: "candidate", text: "cumulative answer", clientId: "1:in-google-input-0-1" },
    ]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
