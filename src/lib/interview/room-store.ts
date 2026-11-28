/**
 * Default persistence for the token-scoped room (FR-INTERVIEW-004). The
 * implementation lives in service.ts as `createRoomStore`, next to the typed
 * path: both share one token→session resolution
 * (invitations.findActiveSessionByToken) and one message-append with
 * sequence-conflict retry and idempotency-index fallback, so a concurrent
 * duplicate insert deduplicates instead of 500ing (NFR-REL-002). The token
 * grants access to that interview's transcript only — never to the owner's
 * account or other data. The runtime batch's content-aware realtime unit/kind
 * rules were folded into that shared store during the merge.
 */
export { createRoomStore as createDefaultRoomStore } from "./service";
