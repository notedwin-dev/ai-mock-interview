import { describe, expect, it, vi } from "vitest";
import { RoomError, runRoomTurn, type RoomContext, type RoomStore, type TranscriptEntry } from "./room";

/**
 * Hermetic tests for the token-scoped interview room (FR-INTERVIEW-002/004,
 * FR-SETUP-008). The persistence seam and the LLM are faked; no network or
 * database is involved. The default store has separate DB-backed tests.
 */
const TOKEN = "t".repeat(43);
const context: RoomContext = {
  sessionId: "session-1",
  userId: "owner-1",
  jobRole: "Backend Engineer",
  jobDescription: "Design APIs",
  evaluationMode: "balanced",
  status: "scheduled",
};

function fakeStore(initial: RoomContext = context) {
  const current = { ...initial };
  let seq = 0;
  let unitSeq = 0;
  const messages: TranscriptEntry[] = [];
  const units: Array<{ id: string; status: string }> = [];
  const store: RoomStore = {
    async context() { return { ...current }; },
    async messages() { return [...messages]; },
    async activate() { current.status = "active"; },
    async appendCandidate(sessionId, contentText, idempotencyKey, assessmentUnitId) {
      if (idempotencyKey) {
        const found = messages.find((m) => m.contentText === contentText);
        if (found) return { entry: found, created: false };
      }
      const entry = {
        sequenceNumber: ++seq,
        speakerType: "candidate",
        messageKind: "candidate_response",
        contentText,
        assessmentUnitId,
      };
      messages.push(entry);
      return { entry, created: true };
    },
    async appendInterviewer(_sessionId, contentText, messageKind, assessmentUnitId) {
      const entry = {
        sequenceNumber: ++seq,
        speakerType: "interviewer",
        messageKind,
        contentText,
        assessmentUnitId,
      };
      messages.push(entry);
      return entry;
    },
    async activeUnit() { return units.find((u) => u.status === "open")?.id ?? null; },
    async openUnit() {
      units.filter((u) => u.status === "open").forEach((u) => { u.status = "closed"; });
      const id = `unit-${++unitSeq}`;
      units.push({ id, status: "open" });
      return id;
    },
    async complete() { current.status = "completed"; },
    async appendRealtimeMessage(sessionId, message) {
      const entry = {
        sequenceNumber: ++seq,
        speakerType: message.speaker,
        messageKind: message.speaker === "candidate" ? "candidate_response" : "primary_question",
        contentText: `${message.clientId}:${message.contentText}`,
        assessmentUnitId: null,
      };
      messages.push(entry);
      return entry;
    },
  };
  return { store, messages, units, state: () => current };
}

const llmRoute = {
  providerName: "openai", providerType: "preset", baseUrl: "https://x/v1", modelId: "m", apiKey: "k",
};

describe("runRoomTurn", () => {
  it("activates on first turn and persists candidate then interviewer in one unit", async () => {
    const { store, messages, units, state } = fakeStore();
    const generate = vi.fn(async () => ({
      interviewerText: "Tell me about a hard bug you fixed.",
      messageKind: "primary_question" as const,
      endCall: false,
    }));

    const result = await runRoomTurn(
      TOKEN,
      { contentText: "I am ready" },
      { store, resolveRoute: async () => llmRoute, generate },
    );

    expect(state().status).toBe("active");
    expect(result.created).toBe(true);
    expect(result.messages.map((m) => `${m.speakerType}:${m.messageKind}`)).toEqual([
      "candidate:candidate_response",
      "interviewer:primary_question",
    ]);
    // The first candidate message precedes any question and is deliberately
    // outside an assessment unit; the interviewer's primary question opens one.
    expect(messages[0]?.assessmentUnitId).toBeNull();
    expect(messages[1]?.assessmentUnitId).toBe("unit-1");
    expect(units).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("keeps a follow-up in the active unit and closes it for a new primary question", async () => {
    const { store, units, messages } = fakeStore();
    const outputs = [
      { interviewerText: "Q1?", messageKind: "primary_question" as const, endCall: false },
      { interviewerText: "Why?", messageKind: "follow_up_question" as const, endCall: false },
      { interviewerText: "Q2?", messageKind: "primary_question" as const, endCall: false },
    ];
    let call = 0;
    const deps = { store, resolveRoute: async () => llmRoute, generate: async () => outputs[call++]! };

    await runRoomTurn(TOKEN, { contentText: "a1" }, deps);
    await runRoomTurn(TOKEN, { contentText: "a2" }, deps);
    await runRoomTurn(TOKEN, { contentText: "a3" }, deps);

    expect(units.map((u) => u.status)).toEqual(["closed", "open"]);
    expect(messages.filter((m) => m.messageKind === "follow_up_question")[0]?.assessmentUnitId).toBe("unit-1");
    expect(messages.filter((m) => m.messageKind === "primary_question").map((m) => m.assessmentUnitId)).toEqual(["unit-1", "unit-2"]);
  });

  it("is idempotent on the candidate key: no duplicate reply or extra generation", async () => {
    const { store } = fakeStore();
    const generate = vi.fn(async () => ({
      interviewerText: "Q1?", messageKind: "primary_question" as const, endCall: false,
    }));
    const deps = { store, resolveRoute: async () => llmRoute, generate };
    const first = await runRoomTurn(TOKEN, { contentText: "hello", idempotencyKey: "turn-1" }, deps);
    const retry = await runRoomTurn(TOKEN, { contentText: "hello", idempotencyKey: "turn-1" }, deps);

    expect(retry.created).toBe(false);
    expect(retry.messages).toEqual(first.messages);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("attaches interviewer audio and never lets a voice failure break the turn", async () => {
    const { store } = fakeStore();
    const base = {
      store,
      resolveRoute: async () => llmRoute,
      generate: async () => ({ interviewerText: "Tell me more.", messageKind: "follow_up_question" as const, endCall: false }),
    };
    const ttsRoute = { providerName: "fish-audio", providerType: "preset", baseUrl: "https://api.fish.audio", modelId: "s2.1-pro-free", apiKey: "k" };

    const withAudio = await runRoomTurn(TOKEN, { contentText: "my answer" }, {
      ...base,
      tts: { resolveRoute: async () => ttsRoute, synthesize: async () => new Uint8Array([1, 2, 3]) },
    });
    expect(withAudio.audioBase64).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect(withAudio.messages).toHaveLength(2);

    const failedVoice = await runRoomTurn(TOKEN, { contentText: "another answer" }, {
      ...base,
      tts: { resolveRoute: async () => ttsRoute, synthesize: async () => { throw new Error("voice down"); } },
    });
    expect(failedVoice.audioBase64).toBeNull();
    expect(failedVoice.messages).toHaveLength(4); // turn text still persisted
  });

  it("stores a closing transition as an acknowledgement with no assessment unit", async () => {
    const { store, messages, units } = fakeStore();
    const result = await runRoomTurn(
      TOKEN,
      { contentText: "Thanks for the interview." },
      {
        store,
        resolveRoute: async () => llmRoute,
        generate: async () => ({
          interviewerText: "That is everything — thanks for your time.",
          messageKind: "transition" as const,
          endCall: true,
        }),
      },
    );

    const reply = messages[messages.length - 1];
    // "transition" is not in the message_kind domain: it is stored as a
    // conversational acknowledgement and never independently evaluated.
    expect(reply?.messageKind).toBe("acknowledgement");
    expect(reply?.assessmentUnitId).toBeNull();
    expect(units).toHaveLength(0);
    expect(result.endCall).toBe(true);
  });

  it("opens an assessment unit when the very first reply is a follow-up", async () => {
    const { store, messages, units } = fakeStore();
    await runRoomTurn(
      TOKEN,
      { contentText: "I have been working as a developer." },
      {
        store,
        resolveRoute: async () => llmRoute,
        generate: async () => ({
          interviewerText: "Can you tell me more about that?",
          messageKind: "follow_up_question" as const,
          endCall: false,
        }),
      },
    );

    // A follow-up with no active unit would leave the question unassessable.
    expect(units).toHaveLength(1);
    expect(messages[messages.length - 1]?.messageKind).toBe("primary_question");
    expect(messages[messages.length - 1]?.assessmentUnitId).toBe("unit-1");
  });

  it("rejects unknown links and interviews that are not in a joinable state", async () => {
    const { store } = fakeStore();
    const missing = fakeStore({ ...context, status: "completed" });
    const deps = { resolveRoute: async () => llmRoute, generate: async () => ({ interviewerText: "x", messageKind: "transition" as const, endCall: true }) };

    await expect(runRoomTurn("bad", { contentText: "hi" }, { ...deps, store: { ...store, context: async () => null } })).rejects.toMatchObject({ code: "invitation_not_found" });
    await expect(runRoomTurn(TOKEN, { contentText: "hi" }, { ...deps, store: missing.store })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(runRoomTurn(TOKEN, { contentText: "" }, { ...deps, store })).rejects.toBeInstanceOf(RoomError);
  });
});
