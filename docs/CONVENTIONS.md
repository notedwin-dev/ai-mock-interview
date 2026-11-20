# AIMIS Repository Conventions

## Naming

- **Database**: lowercase `snake_case` for tables and columns (approved ADR-020).
  Table names follow the data dictionary v0.4 exactly (e.g. `user_provider_configuration`).
- **TypeScript**: `camelCase` locals, `PascalCase` types/components, `SCREAMING_SNAKE`
  for env literals and constants that mirror env vars.
- **Files**: components `PascalCase.tsx`; modules `kebab-case.ts`; tests colocated as
  `<module>.test.ts`; route handlers `route.ts` per App Router convention.
- **Requirement UIDs**: `FR-<GROUP>-NNN` / `NFR-<ATTRIBUTE>-NNN` — always quote the UID
  in commit messages, PR titles and task notes so traceability survives grepping.
- **Task IDs**: Notion Task Tracker `Task ID` (1…20 today). Reference as `TT-<id>`.
- **Repo ADRs**: `docs/adr/NNNN-kebab-title.md`, independent numbering from Notion's
  `ADR-001…030` register (cross-reference Notion IDs inside the ADR body).

## TypeScript / code style

- Strict mode; no `any` in new code (use `unknown` + narrowing or a zod schema).
- Public functions carry explicit return types; inputs are validated or typed at the
  boundary they enter.
- Prefer pure functions with injected dependencies (db client, clock) so business rules
  are unit-testable without a database.
- Error handling: throw typed `AppError`s at service boundaries; route handlers map
  them to sanitized responses. Never `catch {}` silently; never log secrets,
  transcripts or provider payloads (NFR-PRIV-006).
- Imports use the `@/` alias; generated Prisma client imports only from
  `@/generated/prisma/client` (gitignored, rebuilt by `pnpm install`).
- Next.js 16 caveats: use `proxy.ts` (not `middleware.ts`); `cacheComponents` is on —
  follow current `node_modules/next/dist/docs/` guides rather than training-data
  patterns (see AGENTS.md block).

## Git

- **Branches**: never commit directly to `main`. Short-lived branches use the
  prefixes `feature/*` (new features), `bugfix/*` (fixes) and `refactor/*` (minor
  patches, package updates, codebase refactoring, feature updates), e.g.
  `feature/tt10-provider-config-service`. One branch per feature, or one per set of
  closely related features when they belong in the same PR.
- **PR flow**: feature branch → `staging` → `main`. Target `staging` for PRs; a
  separate reviewed PR promotes `staging` to `main`.
- **Commits**: Conventional Commits — `type(scope): summary`. Scope is a module or task
  (`feat(interview): …`, `fix(eval): …`). Reference requirement/task UIDs in the body
  when applicable. Example:

  ```
  feat(interview): persist finalized transcript messages (FR-TRANSCRIPT-001/002, TT-8)

  - sequence numbers per session, insert idempotent on (session_id, sequence_number)
  - unit tests for ordering and duplicate suppression
  ```

- **Do not commit**: `.env` (gitignored), generated Prisma client, `storage/*` media,
  build output. `.env.example` is the only environment template and IS tracked
  (`.gitignore` uses `!.env.example`). Never put a real key in it.
- The `AGENTS.md` next-dev block at the top of the file is managed by Next.js — commit
  it, never strip it from a diff.
- **Human review gates** (approved working rule): authentication, authorization,
  secrets, migrations, provider routing and privacy changes require owner review
  before merge — mark PRs with these concerns explicitly.

## Notion sync rules

- Requirement/status/priority changes: update the Notion register, not local files.
- Task status transitions (Backlog → In progress → Done - Pending Test → …) happen in
  the Task Tracker; local `BACKLOG.md` mirrors intent only and must not drift into a
  second tracker.
- New approved decisions: Notion decision register first (owner records), repo ADR
  second (engineering detail). Never mark a Notion item Approved/Verified without
  explicit owner or test evidence — approval ≠ verification.
- Never create duplicate pages/diagrams; edit the existing Draw.io XML blocks in place.

## Dependency policy

- Add a dependency only when a requirement needs it; dead-weight deps are removed.
- Pin exact versions for runtime deps that touch AI providers (Prisma trio already
  pinned to 7.10.0 to stay in step).
- pnpm 10 blocks lifecycle scripts by default; new packages needing postinstall must be
  allow-listed in `pnpm-workspace.yaml` (prisma + @prisma/engines already are).
