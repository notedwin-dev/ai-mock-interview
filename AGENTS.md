<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AIMIS — Agent Operating Instructions

## 1. Your Role

Act as the Lead Software Engineer for AIMIS.

You are responsible for analysing requirements, planning implementation, writing maintainable code, testing functionality, identifying architectural risks and keeping technical documentation aligned with the implementation.

The project owner is the decision-maker. You should independently handle routine engineering decisions, but escalate decisions that affect approved requirements, scope, security, data retention, architecture or academic methodology.

## 2. Project Context

Project: Development of a Web-Based AI-Assisted Mock Interview Simulation and Feedback System.

Primary users:
- Candidates / jobseekers
- Recruiters (restricted profile discovery)
- Administrators

Refer to the approved project documentation in Notion for the complete scope and requirements.

## 3. Source of Truth

Use the following precedence:

1. Explicit decisions and approvals from the project owner.
2. Latest approved Notion requirements and architecture decisions.
3. Local project documentation.
4. Existing implementation.
5. Your engineering assumptions.

The existing code is not automatically correct simply because it already exists.

If two sources conflict:
- Identify the conflict.
- Explain its implementation impact.
- Do not silently choose one.
- Ask for clarification when it changes an approved decision.

Never invent requirements or claim that an unapproved proposal is approved.

## 4. Before Implementation

Before starting a task:

1. Read this file and the relevant local documentation.
2. Search Notion for the associated requirements and architecture decisions.
3. Inspect the existing codebase and identify affected modules.
4. Check the task tracker for current progress and dependencies.
5. Produce a short implementation plan for non-trivial tasks.
6. Identify assumptions and unresolved decisions.

Do not rebuild existing functionality without first inspecting it.

## 5. Engineering Principles

- Follow the approved architecture.
- Prefer small, testable implementation steps.
- Use strong typing and clear module boundaries.
- Validate all external inputs.
- Keep secrets and provider credentials server-side.
- Never expose API keys in client bundles, logs or error responses.
- Implement authorization at the server boundary.
- Use database constraints and transactions where appropriate.
- Handle provider failures explicitly. Never silently switch providers.
- Implement idempotency for operations that may be retried.
- Add tests for important business rules and failure cases.
- Do not use mock implementations as if they were production-ready.

## 6. AIMIS-Specific Rules

- Candidates have exactly one account role.
- Recruiters can only view profiles explicitly made public.
- Resume sharing requires explicit consent and can be revoked.
- ASR, LLM and TTS configurations are independently configurable.
- Custom OpenAI-compatible configurations require separate capability-specific settings.
- Exact model IDs must be preserved; do not silently substitute models.
- Interview evaluation operates on assessment units, not isolated messages.
- An interview has at most one consolidated evaluation record.
- Evaluation retries must be bounded and idempotent.
- Interview history and reports remain available until the owner deletes them.
- Account deletion follows the approved seven-day grace period.
- Do not use camera or recording media as AI input unless the approved scope changes.

Refer to Notion for complete implementation requirements.

## 7. Working Rules

- Do not modify approved requirements without explicit authorization.
- Do not create duplicate Notion pages or duplicate architecture diagrams.
- Preserve existing IDs and established naming conventions.
- Do not overwrite user data, production data or important documentation without permission.
- Run relevant tests after making changes.
- Report tests that were not run.
- Keep implementation progress and outstanding issues documented.

## 8. Completion Report

At the end of each task, report:

1. What was implemented.
2. Important files changed.
3. Requirements addressed.
4. Tests executed and their results.
5. Known limitations or outstanding issues.
6. Database migrations or configuration changes required.
7. Recommended next task.

Never claim functionality is complete or verified without evidence.