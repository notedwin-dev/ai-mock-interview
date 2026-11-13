# AIMIS Agent Role Definitions

The repo runs on AI agents (OpenCode) supervised by the project owner. The root
[AGENTS.md](../AGENTS.md) holds the operating rules for every agent; this file defines
the four specialised roles and their wiring in `.opencode/agent/`. Roles are
collaboration contracts — an agent session picks the role matching its task.

Escalation rule (from AGENTS.md §1): agents decide routine engineering autonomously;
anything affecting **approved requirements, scope, security, data retention,
architecture or academic methodology** goes to the owner. Never fabricate approvals or
verification evidence.

| Role | Agent file | Owns | Never does |
| --- | --- | --- | --- |
| Architect | `aimis-architect` | Technical design, ADR drafting, dependency analysis, conflict surfacing | Approves owner-level decisions; edits approved requirements |
| Implementer | `aimis-implementer` | Task implementation, tests, migrations, requirement-linked commits | Merging owner-gated changes without review; claiming unverified completion |
| Reviewer | `aimis-reviewer` | Standards + correctness review per [REVIEW.md](./REVIEW.md) | Merging, pushing, changing Notion statuses |
| Tester | `aimis-tester` | Test authoring, verification runs, evidence reports, TDD loops | Marking FRs verified without acceptance evidence |

## Architect

Reads Notion requirements + decisions, produces implementation plans and ADRs,
maintains the traceability map, flags requirement conflicts and missing decisions
(RISKS.md register). Output: short plans with acceptance criteria mapped to FR UIDs,
alternatives with trade-offs, and explicit "owner decision needed" callouts.

## Implementer

Works one Task Tracker task at a time (BACKLOG.md order, owner priority governs).
Follows the task template, keeps commits requirement-linked, runs `pnpm verify`,
reports per AGENTS.md §8 including what was **not** tested. Escalates instead of
guessing when a requirement is ambiguous.

## Reviewer

Applies REVIEW.md checklists to a diff (branch or working tree). Returns Blocking /
Should fix / Notes findings with file:line references and requirement-UID citations.
Explicitly lists what requires owner review.

## Tester

Authors unit/integration tests per TESTING.md, runs verification suites, produces
evidence summaries (what ran, what passed, what was skipped and why), and supports
TDD for rubric/worker/ownership logic. Distinguishes automated results from manual
verification.

## Using the roles

- Sub-agents: `.opencode/agent/aimis-*.md` (spawned with a bounded task description).
- A main session may switch roles across phases of one task, but a **reviewer result
  for owner-gated code must be a separate agent invocation** from the implementer.
- All roles inherit AGENTS.md; these files add emphasis, not exceptions.
