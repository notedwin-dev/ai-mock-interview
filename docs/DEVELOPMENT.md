# AIMIS Development Workflow

Setup lives in the repo [README](../README.md) (Node 22 + pnpm 10, Postgres via Docker
Compose or `pnpm db:local`). This document is the working rhythm.

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Next.js dev server (Turbopack) |
| `pnpm build` / `pnpm start` | Production build / serve (normal output) |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest, single run |
| `pnpm test:watch` | Vitest watch mode |
| `pnpm verify` | lint + typecheck + test — the minimum gate for every change |
| `pnpm db:generate` | Regenerate Prisma client (after every schema change) |
| `pnpm db:migrate` | Create + apply a dev migration |
| `pnpm db:deploy` | Apply existing migrations (production/CI) |
| `pnpm db:studio` | Prisma Studio |
| `pnpm db:local` | Local Postgres without Docker |

`pnpm verify` is **always** run before reporting a task done. Claiming completion
without running it violates AGENTS.md §8.

## Task lifecycle (mirrors Notion Task Tracker)

1. **Pick** a task from the Task Tracker (owner priority governs order — see
   [BACKLOG.md](./BACKLOG.md)).
2. **Read**: AGENTS.md, the FR/NFR rows related to the task, the relevant doc here.
3. **Plan** non-trivial work with [templates/TASK.md](./templates/TASK.md): affected
   modules, acceptance criteria mapped to FR UIDs, test plan, risks/assumptions.
4. **Implement** in small, verifiable steps; one concern per commit.
5. **Verify**: `pnpm verify` + any task-specific evidence (integration test run,
   manual voice-path check, screenshot for UI tasks). Record what was *not* tested.
6. **Report** using AGENTS.md §8 structure (implemented / files / requirements /
   tests / limitations / migrations / next task).
7. **Update Notion**: Task status, FR statuses only when acceptance evidence exists,
   Issue Tracker for anything discovered.

## Definition of done (per task)

- Acceptance criteria in the task template are checked with evidence.
- `pnpm verify` green on the final commit.
- No secrets in code, logs or responses; no transcript content in logs.
- Authorization/ownership enforced at the server boundary for any new resource.
- New DB behaviour has a migration (never hand-edited) and constraint tests.
- Requirement statuses updated in Notion only with real evidence; everything else
  stays "Under Review" / "In progress" honestly.

## Human review gates

Owner review is mandatory before merge for: authentication, authorization, secrets,
migrations, provider routing and privacy behaviour (approved development approach).
AI agents must not merge such changes themselves.

## Local data reset

Dangerous operations (`prisma migrate reset`) wipe local dev data only — never run
against a deployed database. Production data changes follow the deletion lifecycle
requirements (7-day grace, cascades), not ad-hoc SQL.

## Environment

Copy `.env.example` → `.env` and fill required values (see
[ENVIRONMENT.md](./ENVIRONMENT.md)). Missing env vars fail fast at boot by design
(`src/lib/env.ts` zod schema) — add new vars to the schema **and** the example file in
the same change.
