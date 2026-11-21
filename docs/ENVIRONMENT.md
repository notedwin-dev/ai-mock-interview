# AIMIS Environment Variables

Rules (NFR-DEP-003/004): all configuration enters via environment; `.env` is local-only
and never committed; `.env.example` is the documented template; dev and production
configs are separated; **secrets never appear in client bundles, logs or error
responses**.

Required variables must be added to the zod schema in `src/lib/env.ts` and to
`.env.example` in the same change — the app fails fast at boot when something is
missing.

## Current (scaffold)

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | ✅ server | PostgreSQL connection string consumed by `prisma7.config.ts` and the pg driver adapter (`postgresql://…`) |
| `SHADOW_DATABASE_URL` | `prisma migrate dev` only | Disposable shadow database replayed by migrations (Prisma 7 requires it in `prisma7.config.ts`); **never point it at the real database**. Compose creates `aimis_shadow` via `deploy/initdb`; `pnpm db:local` prints its own. Native Postgres (owner-managed dev DB): create it yourself — **Prisma never creates a configured shadow database**, it only requires it to exist |
| `TEST_DATABASE_URL` | integration tests only | Dedicated database for `*.db.test.ts` suites (see TESTING.md); unset ⇒ those tests skip and `pnpm test` stays hermetic |
| `AUTH_SECRET` | ✅ server (auth) | Auth.js v5 JWT signing key. Generate: `openssl rand -base64 32` (or `npx auth secret`). Validated lazily by `src/lib/auth/env.ts` (min 16 chars) on the first auth use — never at build time |
| `AUTH_TRUST_HOST` | production (auth) | Set to `"true"` when self-hosting behind the reverse proxy (compose nginx) so Auth.js may build callback URLs from the Host header; `next dev` trusts localhost by default |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | compose only | Docker Compose defaults (`aimis`/`aimis`/`aimis`) |
| `BUILD_STANDALONE` | build only | Set to `1` in the Dockerfile builder stage; enables `output: "standalone"` (breaks local `next start`, so it is opt-in) |
| `BUILD_DATABASE_URL` | Docker build only | Placeholder `DATABASE_URL` for the builder stage (route modules are evaluated at build; nothing connects). Default in the Dockerfile; override only if `next build` needs a different one |
| `PROVIDER_ENCRYPTION_MASTER_KEY` | ✅ server (provider config) | Master key (32 bytes, base64) for AES-256-GCM encryption of user provider API keys at rest — **stored outside the database**. Validated lazily by `src/lib/providers/env.ts` on first provider-crypto use — never at build time. Generate: `openssl rand -base64 32` |
| `PROVIDER_ENCRYPTION_KEY_VERSION` | ✅ server (provider config) | Active key version written to `user_provider_configuration.encryption_key_version` on save and prefixed into the envelope (`v<version>:…`, ADR-0005) |
| `PROVIDER_ENCRYPTION_LEGACY_KEYS` | server (provider config, rotation only) | Comma-separated retired keys as `<version>=<base64 32-byte key>` pairs, kept decryptable during rotation until no stored row references their version. Omitting a version that rows still reference **fails decryption closed** (repo extension of ADR-0005, flagged for owner review) |
| `STORAGE_LOCAL_ROOT` | server (resume storage) | Local volume root for private resume files (default `./storage`, gitignored; mount a Docker volume at this path in deployment). Keys are built server-side only; files are served exclusively through authenticated route handlers that re-check ownership (recruiter consent re-check lands with FR-RECRUITER-004, M4) |

| `LIVEKIT_URL` | WebRTC room (server) | `wss://…` URL of the LiveKit Cloud project (free Build plan, no card) or self-hosted server. Server-side only |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | WebRTC room (server) | LiveKit project credentials used to mint short-lived participant tokens. **Never** send the secret to the browser or put it in a `NEXT_PUBLIC_` variable |
| `GOOGLE_GENERATIVE_AI_API_KEY` | LiveKit agent / free-tier smokes | Owner-supplied Gemini key (free tier). Used by the LiveKit Agents Gemini Live realtime model and by the one-off free-tier evidence scripts; never printed |

Start the single voice agent with `pnpm agent` (`scripts/livekit-agent.mjs`,
agent name `aimis-agent`). It serves both the planner and interviewer roles based
on dispatch metadata — the Build plan allows one deployed agent. It uses the same
`GOOGLE_GENERATIVE_AI_API_KEY` and LiveKit credentials; no Vapi account or key is
required, and the worker capability for each generation is stored only as a hash
server-side.

For the LiveKit interview runtime, configure a webhook in the LiveKit project
pointing at `https://<your-host>/api/v1/webhooks/livekit` for `room_started` and
`room_finished`. The endpoint verifies signatures with `WebhookReceiver` using
the same `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`; no extra secret is needed. The
room name is the interview session id, so these events drive the
`scheduled → active → completed` lifecycle with no client-side calls.

## Planned (add with their milestone — do not enable early)

| Variable | Planned | Purpose |
| --- | --- | --- |
| `PROVIDER_ENCRYPTION_KEY_VERSION` | M1 provider config | Active key version written to `encryption_key_version` |
| `EVALUATION_WORKER_ENABLED` | M3 eval worker | `1` enables the in-process worker; set `0` on replicas that must not run the worker |
| `EVALUATION_WORKER_POLL_MS` | M3 eval worker | Poll interval for due jobs |
| `EVALUATION_MAX_ATTEMPTS` | M3 eval worker | Bounded retry cap before a job is marked failed |
| `LOG_LEVEL` | M1 logging | Minimal, content-free operational logging |
| `APP_URL` | M2 interview | Absolute app origin for absolute URLs (downloads, OAuth-free callbacks) |

## Smoke-only secrets (never read by application code)

| Variable | Required | Purpose |
| --- | --- | --- |
| `FISH_AUDIO_API_KEY` | live provider smokes only | Owner-supplied Fish Audio key used by one-off evidence scripts (e.g. the TT-16 feasibility run in `FEASIBILITY.md`). The application never reads this variable — provider keys are user-supplied BYOK values that enter through the API and are encrypted at rest. Not part of the `src/lib/env.ts` schema; scripts load it directly from `.env` and must never print it. |

## Secret handling

- Provider API keys are **user-supplied** (BYOK). They are encrypted at rest with the
  master key, write-only from the UI (never returned after save), never logged, never
  sent to the browser, and only decrypted in server memory for an outgoing call.
- The master key must never be committed, echoed into logs, or placed in
  client-accessible config (no `NEXT_PUBLIC_` secret, ever).
- Rotating the master key: introduce the new key with a new `PROVIDER_ENCRYPTION_KEY_VERSION`,
  re-encrypt rows lazily or by a migration job, retire the old version only when no row
  references it.
- `.env` files on a developer machine are local secrets; report accidental commits
  immediately and treat the values as compromised.

## Windows / container notes

- `DATABASE_URL` differs by environment: host dev uses `localhost:5432` (compose db or
  `pnpm db:local`), the app container uses the `db` service hostname.
- Standalone output is produced **inside Docker/Linux**, not from a Windows `.next`
  (junction-point issue documented in the README).
