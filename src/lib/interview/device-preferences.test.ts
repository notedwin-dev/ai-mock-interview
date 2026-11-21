import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVICE_PREFERENCES,
  DEVICE_PREFERENCES_KEY,
  parseDevicePreferences,
  readDevicePreferences,
  saveDevicePreferences,
  type PreferenceStorage,
} from "./device-preferences";

/**
 * Hermetic tests for the waiting-room → room device handoff (FR-INTERVIEW-005/
 * 009). The values never leave the browser, so a fake storage stands in for
 * `sessionStorage`.
 */
function fakeStorage(initial: Record<string, string> = {}): PreferenceStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => { data[key] = value; },
  };
}

describe("device preferences", () => {
  it("round-trips the choices made in the waiting room", () => {
    const storage = fakeStorage();
    saveDevicePreferences({ micId: "mic-1", speakerId: "spk-1", muted: true }, storage);

    expect(storage.data[DEVICE_PREFERENCES_KEY]).toBe(
      JSON.stringify({ micId: "mic-1", speakerId: "spk-1", muted: true }),
    );
    expect(readDevicePreferences(storage)).toEqual({ micId: "mic-1", speakerId: "spk-1", muted: true });
  });

  it("falls back to defaults for a missing, corrupt or hand-edited value", () => {
    expect(readDevicePreferences(fakeStorage())).toEqual(DEFAULT_DEVICE_PREFERENCES);
    expect(parseDevicePreferences("{not json")).toEqual(DEFAULT_DEVICE_PREFERENCES);
    expect(parseDevicePreferences("null")).toEqual(DEFAULT_DEVICE_PREFERENCES);
    expect(parseDevicePreferences(JSON.stringify({ micId: 5, speakerId: "", muted: "yes" })))
      .toEqual(DEFAULT_DEVICE_PREFERENCES);
  });

  it("never throws when storage is blocked", () => {
    const blocked: PreferenceStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(readDevicePreferences(blocked)).toEqual(DEFAULT_DEVICE_PREFERENCES);
    expect(() => saveDevicePreferences(DEFAULT_DEVICE_PREFERENCES, blocked)).not.toThrow();
    expect(readDevicePreferences(undefined)).toEqual(DEFAULT_DEVICE_PREFERENCES);
  });
});
