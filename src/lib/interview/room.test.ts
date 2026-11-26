import { describe, expect, it, vi } from "vitest";
import { RoomError, runRoomTurn, type RoomContext, type RoomStore, type TranscriptEntry } from "./room";
import { InterviewError } from "./service";
import { UnitConflictError } from "./unit-conflict";

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
  // Idempotency ledger keyed by (session, key) — mirrors the DB's partial
  // unique index: the KEY deduplicates, not the message text.
  const byKey = new Map<string, TranscriptEntry>();
  const store: RoomStore = {
    async context() { return { ...current }; },
    async messages() { return [...messages]; },
    async findCandidateByKey(sessionId, idempotencyKey) {
      return byKey.get(`${sessionId}:${idempotencyKey}`) ?? null;
    },
    async activate() {
      if (current.status === "completed") return "rejected" as const;
      if (current.status === "active") return "already_active" as const;
      current.status = "active";
      return "activated" as const;
    },
    async appendCandidate(sessionId, contentText, idempotencyKey, assessmentUnitId) {
      if (idempotencyKey) {
        const found = byKey.get(`${sessionId}:${idempotencyKey}`);
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
      if (idempotencyKey) byKey.set(`${sessionId}:${idempotencyKey}`, entry);
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
    async openUnit() { const id = `unit-${++unitSeq}`; units.push({ id, status: "open" }); return id; },
    async closeUnit(id) { const unit = units.find((u) => u.id === id); if (unit) unit.status = "closed"; },
    async complete() { current.status = "completed"; },
    async rollbackCandidate(sessionId, idempotencyKey) {
      const key = `${sessionId}:${idempotencyKey}`;
      const entry = byKey.get(key);
      if (!entry) return false;
      byKey.delete(key);
      const index = messages.indexOf(entry);
      if (index >= 0) messages.splice(index, 1);
      return true;
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

  it("deduplicates by idempotency key, not by message text", async () => {
    const { store, messages } = fakeStore();
    let call = 0;
    const outputs = [
      { interviewerText: "Q1?", messageKind: "primary_question" as const, endCall: false },
      { interviewerText: "Q2?", messageKind: "primary_question" as const, endCall: false },
      { interviewerText: "Q3?", messageKind: "primary_question" as const, endCall: false },
    ];
    const deps = { store, resolveRoute: async () => llmRoute, generate: async () => outputs[call++]! };

    // Identical text under different keys: both turns are accepted.
    await runRoomTurn(TOKEN, { contentText: "same answer", idempotencyKey: "turn-a" }, deps);
    await runRoomTurn(TOKEN, { contentText: "same answer", idempotencyKey: "turn-b" }, deps);

    // Changed text under the same key: replayed, no third candidate message.
    const replay = await runRoomTurn(TOKEN, { contentText: "changed answer", idempotencyKey: "turn-a" }, deps);

    expect(replay.created).toBe(false);
    const candidateCount = messages.filter((m) => m.speakerType === "candidate").length;
    expect(candidateCount).toBe(2);
  });

  it("replays a completed interview only for a known idempotency key", async () => {
    const { store } = fakeStore({ ...context, status: "completed" });
    const messages = [
      { sequenceNumber: 1, speakerType: "candidate", messageKind: "candidate_response", contentText: "a", assessmentUnitId: null },
      { sequenceNumber: 2, speakerType: "interviewer", messageKind: "primary_question", contentText: "Q", assessmentUnitId: "u1" },
    ];
    const knownKey = "turn-1";
    const finalizedDeps = {
      store: {
        ...store,
        messages: async () => messages,
        findCandidateByKey: async (_sessionId: string, idempotencyKey: string) =>
          idempotencyKey === knownKey
            ? {
                sequenceNumber: 1, speakerType: "candidate", messageKind: "candidate_response", contentText: "a", assessmentUnitId: null,
              }
            : null,
      },
      resolveRoute: async () => llmRoute,
      generate: async () => { throw new Error("must not generate for a replay"); },
    };
    const replay = await runRoomTurn(TOKEN, { contentText: "a", idempotencyKey: knownKey }, finalizedDeps);
    expect(replay).toMatchObject({ endCall: true, created: false });

    await expect(
      runRoomTurn(TOKEN, { contentText: "new work", idempotencyKey: "brand-new-key" }, finalizedDeps),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("rolls the candidate message back when a concurrent turn wins the unit race", async () => {
    const { store, messages } = fakeStore();
    const deps = {
      store: {
        ...store,
        openUnit: async () => {
          throw new UnitConflictError();
        },
      },
      resolveRoute: async () => llmRoute,
      generate: async () => ({ interviewerText: "Q?", messageKind: "primary_question" as const, endCall: false }),
    };

    await expect(
      runRoomTurn(TOKEN, { contentText: "answer", idempotencyKey: "turn-1" }, deps),
    ).rejects.toMatchObject({ code: "invalid_state" });
    // The persisted candidate message was rolled back — nothing is left
    // unanswered in the transcript.
    expect(messages.filter((m) => m.speakerType === "candidate")).toHaveLength(0);
  });

  it("rejects a same-key retry while request A is still generating", async () => {
    const { store, messages } = fakeStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const generate = vi.fn(async () => {
      signalStarted();
      await gate;
      return { interviewerText: "Q1?", messageKind: "primary_question" as const, endCall: false };
    });
    const deps = { store, resolveRoute: async () => llmRoute, generate };

    const first = runRoomTurn(TOKEN, { contentText: "answer", idempotencyKey: "same" }, deps);
    await started;
    await expect(
      runRoomTurn(TOKEN, { contentText: "answer", idempotencyKey: "same" }, deps),
    ).rejects.toMatchObject({ code: "turn_pending" });
    release();
    await first;

    // A single interviewer reply was persisted; the retry never generated.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(messages.filter((m) => m.speakerType === "interviewer")).toHaveLength(1);
  });

  it("maps a completion-won candidate rejection to invalid_state", async () => {
    const { store } = fakeStore();
    const deps = {
      store: {
        ...store,
        appendCandidate: async () => {
          throw new InterviewError("invalid_state", "This interview is not accepting turns.");
        },
      },
      resolveRoute: async () => llmRoute,
      generate: async () => {
        throw new Error("must not generate after completion wins");
      },
    };

    await expect(
      runRoomTurn(TOKEN, { contentText: "late", idempotencyKey: "late-turn" }, deps),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("rejects unknown links and interviews that are not in a joinable state", async () => {
    const { store } = fakeStore();
    const missing = fakeStore({ ...context, status: "completed" });
    const deps = { resolveRoute: async () => llmRoute, generate: async () => ({ interviewerText: "x", messageKind: "follow_up_question" as const, endCall: true }) };

    await expect(runRoomTurn("bad", { contentText: "hi" }, { ...deps, store: { ...store, context: async () => null } })).rejects.toMatchObject({ code: "invitation_not_found" });
    await expect(runRoomTurn(TOKEN, { contentText: "hi" }, { ...deps, store: missing.store })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(runRoomTurn(TOKEN, { contentText: "" }, { ...deps, store })).rejects.toBeInstanceOf(RoomError);
  });
});
