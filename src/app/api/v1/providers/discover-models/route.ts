import { z } from "zod";
import { requireApiAccount } from "@/lib/auth/guard";
import { errorResponse, jsonError, parseJsonBody } from "@/lib/api/respond";
import { discoverCandidateModels } from "@/lib/providers/probe";

/**
 * POST /api/v1/providers/discover-models — lists a candidate provider's
 * model IDs from its list-models endpoint BEFORE a configuration row exists
 * (FR-PROVIDER-009; owner directive 2026-11-16: model setup waits for the
 * API key, then lists the provider's models instead of asking for manual
 * IDs). The key in the request body is used once for this outbound call and
 * is never persisted, cached or logged (write-only credentials, ADR-0005).
 * Target validation failures surface as the provider-config error envelope;
 * wire failures return the probe taxonomy as the DiscoveryResult union.
 */
const bodySchema = z
  .object({
    providerType: z.enum(["preset", "custom"]),
    providerName: z.string().trim().min(1).max(120),
    baseUrl: z.string().trim().max(2048).optional(),
    apiKey: z.string().trim().min(1).max(4096),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  const account = await requireApiAccount({ role: "candidate" });
  if (!account) return jsonError(401, "unauthenticated", "Sign in as a candidate first.");

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await parseJsonBody(request));
  } catch {
    return jsonError(
      400,
      "invalid_input",
      "A provider type, provider name and API key are required to list models.",
    );
  }

  try {
    const result = await discoverCandidateModels(body);
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
