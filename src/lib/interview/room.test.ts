import { describe, expect, it, vi } from "vitest";
import {
  RoomError,
  runRoomTurn,
  type RealtimeTranscriptMessage,
  type RoomContext,
  type RoomStore,
  type TranscriptEntry,
} from "./room";
import type { ProviderRoute } from "@/lib/providers/provider-route";
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
  experienceLevel: null,
  techStack: [],
  questionCount: null,
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
    async appendInterviewerWithNewUnit(_sessionId, contentText) {
      units.filter((u) => u.status === "open").forEach((u) => { u.status = "closed"; });
      const id = `unit-${++unitSeq}`;
      units.push({ id, status: "open" });
      const entry = {
        sequenceNumber: ++seq,
        speakerType: "interviewer",
        messageKind: "primary_question",
        contentText,
        assessmentUnitId: id,
      };
      messages.push(entry);
      return entry;
    },
    async activeUnit() { return units.find((u) => u.status === "open")?.id ?? null; },
    // Both sides combined: explicit unit rollback hooks from our review fixes
    // plus the runtime batch's atomic appendInterviewerWithNewUnit.
    async openUnit() {
      units.filter((u) => u.status === "open").forEach((u) => { u.status = "closed"; });
      const id = `unit-${++unitSeq}`;
      units.push({ id, status: "open" });
      return id;
    },
    async closeUnit(id) { const unit = units.find((u) => u.id === id); if (unit) unit.status = "closed"; },
    async rollbackUnit(id) { const index = units.findIndex((u) => u.id === id); if (index >= 0) units.splice(index, 1); },
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
    // Minimal stand-in: content-aware realtime unit rules have DB-backed tests
    // in invitations.db.test.ts. Accept both call shapes used across the tree.
    async appendRealtimeMessage(
      _sessionId,
      messageOrSpeaker: RealtimeTranscriptMessage | "candidate" | "interviewer",
      positionalContent?: string,
    ) {
      const speaker = typeof messageOrSpeaker === "string" ? messageOrSpeaker : messageOrSpeaker.speaker;
      const contentText = typeof messageOrSpeaker === "string" ? (positionalContent ?? "") : messageOrSpeaker.contentText;
      const entry: TranscriptEntry = {
        sequenceNumber: ++seq,
        speakerType: speaker,
        messageKind: speaker === "candidate" ? "candidate_response" : "primary_question",
        contentText,
        assessmentUnitId: null,
      };
      messages.push(entry);
      return entry;
    },
  };
  return { store, messages, units, state: () => current };
}

const llmRoute: ProviderRoute = {
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
        // Primary questions now use the atomic open+append seam; the unit
        // race is simulated there instead of on the legacy openUnit seam.
        appendInterviewerWithNewUnit: async () => {
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

  it("asks the sixth primary question and completes once it is answered", async () => {
    const { store, messages, units, state } = fakeStore();
    let call = 0;
    const generate = async () => {
      call += 1;
      return call <= 6
        ? { interviewerText: `Q${call}?`, messageKind: "primary_question" as const, endCall: false }
        : { interviewerText: "Thanks — that's everything.", messageKind: "follow_up_question" as const, endCall: false };
    };
    const deps = { store, resolveRoute: async () => llmRoute, generate };

    for (let turn = 0; turn < 6; turn++) {
      const result = await runRoomTurn(
        TOKEN,
        { contentText: `answer ${turn}`, idempotencyKey: `turn-${turn}` },
        deps,
      );
      expect(result.endCall).toBe(false);
    }
    // Six primary questions, each in its own unit, and still open.
    expect(messages.filter((m) => m.messageKind === "primary_question")).toHaveLength(6);
    expect(units).toHaveLength(6);
    expect(state().status).toBe("active");

    const closing = await runRoomTurn(
      TOKEN,
      { contentText: "answer 6", idempotencyKey: "turn-6" },
      deps,
    );
    expect(closing.endCall).toBe(true);
    expect(state().status).toBe("completed");
  });

  it("rejects a non-closing seventh primary question and rolls the answer back", async () => {
    const { store, messages } = fakeStore();
    let call = 0;
    const generate = async () => {
      call += 1;
      return {
        interviewerText: `Q${call}?`,
        messageKind: "primary_question" as const,
        endCall: false,
      };
    };
    const deps = { store, resolveRoute: async () => llmRoute, generate };

    for (let turn = 0; turn < 6; turn++) {
      await runRoomTurn(
        TOKEN,
        { contentText: `answer ${turn}`, idempotencyKey: `turn-${turn}` },
        deps,
      );
    }

    await expect(
      runRoomTurn(TOKEN, { contentText: "answer 6", idempotencyKey: "turn-6" }, deps),
    ).rejects.toMatchObject({ code: "invalid_state" });
    // The rejected answer is not left dangling in the transcript.
    expect(messages.filter((m) => m.speakerType === "candidate")).toHaveLength(6);
    expect(messages.filter((m) => m.messageKind === "primary_question")).toHaveLength(6);
  });

  it("resumes a pending turn after the reply fails and removes its orphaned unit", async () => {
    const { store, messages, units } = fakeStore();
    let failAppend = true;
    const appendWithUnit = store.appendInterviewerWithNewUnit;
    const deps = {
      store: {
        ...store,
        // The first reply write fails after the unit was opened; the fake's
        // atomic seam rolls that unit back before surfacing the failure.
        appendInterviewerWithNewUnit: async (
          ...args: Parameters<RoomStore["appendInterviewerWithNewUnit"]>
        ) => {
          if (failAppend) {
            failAppend = false;
            throw new Error("reply write failed");
          }
          return appendWithUnit(...args);
        },
      },
      resolveRoute: async () => llmRoute,
      generate: async () => ({
        interviewerText: "Q1?",
        messageKind: "primary_question" as const,
        endCall: false,
      }),
    };

    await expect(
      runRoomTurn(TOKEN, { contentText: "hello", idempotencyKey: "turn-1" }, deps),
    ).rejects.toThrow("reply write failed");
    // The candidate message is kept for the retry, but the empty unit is not.
    expect(messages.filter((m) => m.speakerType === "candidate")).toHaveLength(1);
    expect(units).toHaveLength(0);

    const retry = await runRoomTurn(
      TOKEN,
      { contentText: "hello", idempotencyKey: "turn-1" },
      deps,
    );
    expect(retry.created).toBe(false);
    expect(retry.messages.map((m) => `${m.speakerType}:${m.messageKind}`)).toEqual([
      "candidate:candidate_response",
      "interviewer:primary_question",
    ]);
    expect(units).toHaveLength(1);
  });

  it("re-asserts completion when replaying a closing turn whose completion failed", async () => {
    const { store } = fakeStore({ ...context, status: "active" });
    const candidate: TranscriptEntry = {
      sequenceNumber: 7,
      speakerType: "candidate",
      messageKind: "candidate_response",
      contentText: "answer",
      assessmentUnitId: "unit-6",
    };
    const history: TranscriptEntry[] = [
      ...Array.from({ length: 6 }, (_, index) => ({
        sequenceNumber: index + 1,
        speakerType: "interviewer",
        messageKind: "primary_question",
        contentText: `Q${index + 1}?`,
        assessmentUnitId: `unit-${index + 1}`,
      })),
      candidate,
      {
        sequenceNumber: 8,
        speakerType: "interviewer",
        messageKind: "follow_up_question",
        contentText: "Thanks — that's everything.",
        assessmentUnitId: "unit-6",
      },
    ];
    const complete = vi.fn(store.complete);
    const deps = {
      store: {
        ...store,
        messages: async () => history,
        findCandidateByKey: async () => candidate,
        appendCandidate: async () => ({ entry: candidate, created: false }),
        complete,
      },
      resolveRoute: async () => llmRoute,
      generate: async () => {
        throw new Error("must not generate for a finalized reply");
      },
    };

    const replay = await runRoomTurn(
      TOKEN,
      { contentText: "answer", idempotencyKey: "turn-6" },
      deps,
    );
    expect(replay).toMatchObject({ endCall: true, created: false });
    expect(complete).toHaveBeenCalledTimes(1);
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

  it("attaches interviewer audio and never lets a voice failure break the turn", async () => {
    const { store } = fakeStore();
    const base = {
      store,
      resolveRoute: async () => llmRoute,
      generate: async () => ({ interviewerText: "Tell me more.", messageKind: "follow_up_question" as const, endCall: false }),
    };
    const ttsRoute: ProviderRoute = { providerName: "fish-audio", providerType: "preset", baseUrl: "https://api.fish.audio", modelId: "s2.1-pro-free", apiKey: "k" };

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
    const deps = { resolveRoute: async () => llmRoute, generate: async () => ({ interviewerText: "x", messageKind: "follow_up_question" as const, endCall: true }) };

    await expect(runRoomTurn("bad", { contentText: "hi" }, { ...deps, store: { ...store, context: async () => null } })).rejects.toMatchObject({ code: "invitation_not_found" });
    await expect(runRoomTurn(TOKEN, { contentText: "hi" }, { ...deps, store: missing.store })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(runRoomTurn(TOKEN, { contentText: "" }, { ...deps, store })).rejects.toBeInstanceOf(RoomError);
  });
});
