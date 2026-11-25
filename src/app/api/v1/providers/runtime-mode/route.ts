import { z } from "zod";
import { errorResponse, jsonError, parseJsonBody } from "@/lib/api/respond";
import { requireApiAccount } from "@/lib/auth/guard";
import {
  getActiveRuntimeMode,
  RUNTIME_MODES,
  setActiveRuntimeMode,
} from "@/lib/providers/config";

const runtimeModeSchema = z.object({ mode: z.enum(RUNTIME_MODES) });

/** GET /api/v1/providers/runtime-mode — the currently active runtime (null = legacy). */
export async function GET(): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");
  return Response.json({ mode: await getActiveRuntimeMode(account.account.userId) });
}

/**
 * PATCH /api/v1/providers/runtime-mode — switch the active runtime without
 * deleting anything. Configurations of both modes remain stored; the runtime
 * resolver ignores the inactive mode's rows (owner decision 2026-11-20).
 */
export async function PATCH(request: Request): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  try {
    const { mode } = runtimeModeSchema.parse(await parseJsonBody(request));
    await setActiveRuntimeMode(account.account.userId, mode);
    return Response.json({ mode });
  } catch (error) {
    return errorResponse(error);
  }
}
