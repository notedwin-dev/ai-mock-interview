# Task implementation template

Copy this file into a task branch as `docs/tasks/TT-<id>-<slug>.md` (or paste into a
PR description) for any non-trivial task. Keep it short — it is a working plan, not a
report; the completion report follows AGENTS.md §8.

```markdown
# TT-<id> — <Task Name>

## Requirement links
FRs: <FR-XXX-NNN, …>   NFRs: <NFR-XXX-NNN, …>   Decisions: <ADR-xxx / OWNER-xxx>

## Goal
<One or two sentences: what must be true afterwards.>

## Approach
<Modules to touch, key design points, what reuses existing code.>

## Acceptance criteria
- [ ] <Testable statement mapped to an FR UID>
- [ ] …

## Test plan
- Unit: <rules under test>
- Integration (TEST_DATABASE_URL): <flows>
- Manual: <what cannot be automated, e.g. voice path>
- Not covered: <honesty about gaps>

## Risks / assumptions / open decisions
- <Risk — mitigation>
- <Assumption to confirm>
- <Decisions needed from owner, if any>

## Evidence
- pnpm verify: <date, result>
- Additional evidence: <test run names, screenshots, manual check notes>
```

Rules:

- Acceptance criteria must trace to FR/NFR UIDs — if none apply, the task may be
  engineering-only (say so explicitly).
- Do not check a criterion without evidence; "Done - Pending Test" exists in the Task
  Tracker for exactly this state.
- If the task reveals a requirement conflict or needs an owner decision, stop and
  escalate — never invent approval.
