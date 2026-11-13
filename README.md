# AIMIS — AI-Assisted Mock Interview Simulation and Feedback System

Final Year Project (APU3F2605SE). A web-based platform that generates role-specific interview
questions, evaluates answers with AI, and tracks performance across sessions.

**Current state: project scaffold only.** No features are implemented yet — no auth, no interview
flow, no AI calls. See [Deferred to the feature phase](#deferred-to-the-feature-phase).

## Stack

Chosen in IR §2.4, all verified present in the repo:

| Concern | Choice | IR |
| --- | --- | --- |
| Framework / runtime | Next.js 16.4 (App Router, Turbopack) + Node.js | §2.4.5 |
| Language | TypeScript 5.9 throughout front and back end | §2.4.2 |
| Styling | Tailwind CSS 4.3 | §2.4.5 |
| Database | PostgreSQL 17 | §2.4.4 |
| Data layer | Prisma ORM 7.10 + `@prisma/adapter-pg` | §2.4.5 |
| Auth | Auth.js v5, credentials (decided, not yet installed) | §1.6.4 |
| Env validation | zod | — |
| Container | Docker (multi-stage, standalone output) | §2.4.5 |
| Reverse proxy | NGINX | §2.4.8 |

Deliberately **not** installed yet, because they are feature work and would be dead weight:
the LLM provider SDK, Whisper (speech-to-text), ElevenLabs (text-to-speech), Chart.js, and
`MediaRecorder` wiring. Their keys are stubbed in `.env.example`.

## Prerequisites

- Node.js 22 and pnpm 10 (`packageManager` is pinned to `pnpm@10.12.4`)
- Either **Docker** (for the `docker-compose.yml` Postgres) **or** no extra install at all —
  Prisma 7 ships `prisma dev`, a local Postgres you can start with one command.

## Quick start

```bash
pnpm install              # also runs `prisma generate` via postinstall
cp .env.example .env
```

Then get a Postgres running, by either route:

**A. Docker (matches the IR deployment target)**

```bash
docker compose up -d db
```

`.env` already points at `postgresql://aimis:aimis@localhost:5432/aimis`, which matches the
compose defaults.

**B. No Docker — Prisma's bundled local Postgres**

```bash
pnpm db:local
```

This prints a `postgres://…` URL on a random port; set `DATABASE_URL` in `.env` to that value.
Fine for day-to-day development; the real deployment still targets Docker/PostgreSQL.

Verify the wiring and start the dev server:

```bash
pnpm prisma validate
pnpm dev
```

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` / `build` / `start` | Next.js |
| `pnpm lint` / `typecheck` | ESLint / `tsc --noEmit` |
| `pnpm test` / `test:watch` | Vitest (hermetic unit tests; see `docs/TESTING.md`) |
| `pnpm verify` | lint + typecheck + test — minimum gate for every change |
| `pnpm db:generate` | Regenerate the Prisma client (re-run after every schema change) |
| `pnpm db:migrate` | Create + apply a migration (dev) |
| `pnpm db:deploy` | Apply existing migrations (production/CI) |
| `pnpm db:studio` | Prisma Studio |
| `pnpm db:local` | Local Postgres without Docker |

## Documentation

Engineering docs live in [`docs/`](docs/README.md) — architecture, conventions,
development workflow, testing strategy, environment variables, requirements
traceability, backlog, risks, review checklists, agent roles and ADRs. Notion remains
the source of truth for requirements and decisions; the docs map them onto the code.

## Layout

```
prisma/schema.prisma        datasource + generator; no domain models yet
prisma7.config.ts           Prisma 7 CLI config — reads DATABASE_URL via dotenv
src/generated/prisma/       generated client (gitignored, rebuilt by postinstall)
src/lib/db.ts               PrismaClient singleton, pg driver adapter
src/lib/env.ts              zod-validated server environment
storage/recordings/         local volume for the 24h user recordings
deploy/nginx.conf           reverse proxy to the app container
docker-compose.yml          db + app + nginx
```

## Prisma 7 gotchas

Prisma 7 differs enough from the 5/6 tutorials most people know:

1. **The `latest` npm tag points at an 8.0.0 release candidate.** This project pins `7.10.0`
   for `prisma`, `@prisma/client`, and `@prisma/adapter-pg` so the three stay in step.
2. **`datasource` has no `url` line.** The connection URL lives in `prisma7.config.ts`, which
   is the filename this version loads (not `prisma.config.ts`).
3. **`.env` is no longer auto-loaded by the CLI.** `prisma7.config.ts` imports `dotenv/config`.
4. **A driver adapter is required.** `new PrismaClient({ adapter: new PrismaPg({…}) })` —
   there is no bundled query engine to fall back on.
5. **The generator writes TypeScript source**, not into `node_modules`:
   `provider = "prisma-client"`, `output = "../src/generated/prisma"`. Import from
   `@/generated/prisma/client`. Because that directory is gitignored, `pnpm install` must run
   before `pnpm build` on a fresh clone.
6. **pnpm 10 blocks postinstall scripts by default.** `pnpm-workspace.yaml` allow-lists
   `prisma` and `@prisma/engines`; without it the schema engines never download and
   `prisma generate` fails.

## Next.js 16 gotchas

- The `middleware.ts` file convention is deprecated; it is now **`proxy.ts`**. Relevant when
  auth route-guarding is added.
- `output: "standalone"` is what the Docker image is built with, but enabling it unconditionally
  breaks `next start`, so it is opted into by `BUILD_STANDALONE=1` (set in the `Dockerfile`'s
  builder stage). Local `pnpm build` / `pnpm start` stay normal.
- On Windows, standalone generation can fall back to junction points, which are not relocatable
  — build the image inside Docker/Linux rather than from a Windows-produced `.next`.
- `AGENTS.md` at the repo root is rewritten by `next dev`; commit it rather than fighting it.

## Deployment

`docker compose up -d --build` starts Postgres, the app (built from `Dockerfile`, running as a
non-root user), and NGINX on port 80. Run migrations against the deployed database with
`pnpm db:deploy`.

NGINX sets `client_max_body_size 100m` — the 1 MB default would reject uploaded audio/video.
Uncomment the `443` port and certificate mount in `docker-compose.yml` once a certificate exists
(IR §2.4.8 requires HTTPS).

## Deferred to the feature phase

Deliberately out of scope for setup, listed so nothing is mistaken for finished work:

- **Data model** — `schema.prisma` has zero models. Users, interview sessions, questions,
  responses, feedback, and scores are still to be designed (FR01–FR12). JSONB is the intended
  shape for AI feedback payloads (IR §2.4.4).
- **Auth** — install `next-auth` (v5 is still `5.0.0-beta.32`; the stable line is 4.24) plus
  `@auth/prisma-adapter`, and add `AUTH_SECRET`. Register, sign-in, password recovery, and the
  user/admin/recruiter roles are unbuilt.
- **AI layer** — provider not chosen. IR §2.4.5 leaves OpenAI, Anthropic, and Gemini open, and
  the admin module must be able to change provider settings, so wrap access behind a single
  interface rather than one vendor's SDK.
- **Recording retention** — the `storage/` volume exists, but nothing records and the 24-hour
  auto-deletion sweep is not implemented.
- **Progress analytics** — Chart.js not installed (FR09).
- **`pg` is not yet traced into `.next/standalone`** because no route imports `db.ts`. When the
  first database-backed route lands, confirm the driver reaches the image; add
  `outputFileTracingIncludes` for `@prisma/client` and `pg` if it does not.

## Requirements reference

Functional FR01–FR12 and non-functional NFR01–NFR08 come from IR §3.3.15. The recurring theme
in the survey data is distrust of AI scoring (81.5% cited feedback accuracy, 63% score
reliability), so feedback must stay explainable, criteria-based, and framed as guidance rather
than a hiring decision (NFR01, NFR02, NFR06).
