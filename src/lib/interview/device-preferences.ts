/**
 * Device and microphone choices made in the waiting room, carried into the live
 * room (FR-INTERVIEW-005/009). They describe this browser session only: they
 * live in `sessionStorage` and are never sent to the server.
 */
export const DEVICE_PREFERENCES_KEY = "aimis:interview-devices";

export interface DevicePreferences {
  micId: string | null;
  speakerId: string | null;
  muted: boolean;
}

export const DEFAULT_DEVICE_PREFERENCES: DevicePreferences = {
  micId: null,
  speakerId: null,
  muted: false,
};

/** The subset of the Storage API this module needs (injectable in tests). */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function deviceId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parses a stored value defensively: a stale or hand-edited blob is ignored. */
export function parseDevicePreferences(raw: string | null): DevicePreferences {
  if (!raw) return DEFAULT_DEVICE_PREFERENCES;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_DEVICE_PREFERENCES;
    const record = parsed as Record<string, unknown>;
    return {
      micId: deviceId(record["micId"]),
      speakerId: deviceId(record["speakerId"]),
      muted: record["muted"] === true,
    };
  } catch {
    return DEFAULT_DEVICE_PREFERENCES;
  }
}

function browserStorage(): PreferenceStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    // Storage can be blocked (privacy modes); device choices are optional.
    return undefined;
  }
}

export function readDevicePreferences(
  storage: PreferenceStorage | undefined = browserStorage(),
): DevicePreferences {
  if (!storage) return DEFAULT_DEVICE_PREFERENCES;
  try {
    return parseDevicePreferences(storage.getItem(DEVICE_PREFERENCES_KEY));
  } catch {
    return DEFAULT_DEVICE_PREFERENCES;
  }
}

export function saveDevicePreferences(
  preferences: DevicePreferences,
  storage: PreferenceStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(DEVICE_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Quota/private mode: the room still works with the browser defaults.
  }
}
