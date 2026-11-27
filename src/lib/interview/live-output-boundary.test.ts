import { describe, expect, it } from "vitest";
import { isOutputBoundaryFrame } from "./live-output-boundary";

describe("isOutputBoundaryFrame", () => {
  it("keeps the boundary when waitingForInput and turnComplete share a frame", () => {
    // The mapper emits no audio-transcript-done for a turn with no output
    // transcription text; the custom/response-done frame is the only boundary.
    expect(isOutputBoundaryFrame({
      serverContent: { waitingForInput: true, turnComplete: true },
    })).toBe(true);
  });

  it("accepts an IDLE interactionStatus as a boundary", () => {
    expect(isOutputBoundaryFrame({
      serverContent: { interactionStatus: "IDLE", turnComplete: true },
    })).toBe(true);
  });

  it("keeps a bare turnComplete buffered for late deltas", () => {
    expect(isOutputBoundaryFrame({ serverContent: { turnComplete: true } })).toBe(false);
  });

  it("ignores frames with no boundary signal", () => {
    expect(isOutputBoundaryFrame({ serverContent: { turnComplete: false } })).toBe(false);
    expect(isOutputBoundaryFrame({ serverContent: {} })).toBe(false);
    expect(isOutputBoundaryFrame(null)).toBe(false);
    expect(isOutputBoundaryFrame("turnComplete")).toBe(false);
  });
});
