import type { ProviderType } from "./config";

/**
 * Resolved provider route for one capability (shared by the ASR, LLM, TTS
 * and realtime adapters and the interview modules). Carries the plaintext
 * API key: only server code that is about to make the outbound call may hold
 * it, and it must never be cached, logged or returned to a client (ADR-0005,
 * NFR-SEC-008). `resolveForOutboundCall` is the only factory of these values.
 */
export interface ProviderRoute {
  providerName: string;
  providerType: ProviderType;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}
