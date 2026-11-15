# AIMIS Engineering Documentation

Local engineering documentation for AIMIS (AI-Assisted Mock Interview Simulation and
Feedback System). **Notion is the authoritative source for requirements, decisions and
task status**; these docs make the implementation-side conventions, architecture mapping
and verification workflow explicit for humans and AI agents.

| Document | Purpose |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Application architecture, module map, boundaries, AI integration |
| [CONVENTIONS.md](./CONVENTIONS.md) | Naming, code style, git branching and commits, Notion sync rules |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Scripts, daily workflow, task lifecycle, definition of done |
| [TESTING.md](./TESTING.md) | Testing strategy, what must be tested, verification evidence rules |
| [ENVIRONMENT.md](./ENVIRONMENT.md) | Environment variables, secret handling, encryption keys |
| [REQUIREMENTS-TRACEABILITY.md](./REQUIREMENTS-TRACEABILITY.md) | Requirements → modules → tasks dependency map, open decisions |
| [BACKLOG.md](./BACKLOG.md) | Initial implementation backlog and milestone plan |
| [RISKS.md](./RISKS.md) | Risk register and unresolved decision register |
| [FEASIBILITY.md](./FEASIBILITY.md) | Provider/voice-pipeline feasibility matrix with live evidence (TT-16, no CI) |
| [UI-PLAN.md](./UI-PLAN.md) | Candidate UI plan: dashboard, interview setup wizard, meeting-style room (TT-2/TT-8) |
| [REVIEW.md](./REVIEW.md) | Code review instructions and checklists |
| [AGENT-ROLES.md](./AGENT-ROLES.md) | Specialised agent role definitions (architect/implementer/reviewer/tester) |
| [adr/](./adr/) | Architecture decision records (repo-local ADR process) |
| [templates/](./templates/) | Reusable task and ADR templates |

## Authoritative Notion sources

All pages live in the FYP workspace (`https://app.notion.com/p/<id>`).

| Source | ID | Role |
| --- | --- | --- |
| FYP workspace hub | `3b11f0a3fda780e6956edec7089df113` | Navigation, scope baseline, conventions |
| Project Overview & Scope | `4121f0a3fda781c682e4c9eab7500f16` | MVP/High/Low/Excluded scope boundary |
| Functional Requirements (database) | `collection://71846889-0593-4dff-93bc-a738f84d966a` | 88 FRs — authoritative behaviour register |
| Non-functional Requirements (database) | `collection://2ea9f2cb-71ca-4f36-bb6d-0bbd4a24e3ec` | 60 NFRs — quality/constraint register |
| Task Tracker (database) | `collection://95d1f0a3-fda7-83d5-9b6d-072dca68f417` | 19 actionable tasks |
| Issue Tracker (database) | `collection://1a21f0a3-fda7-8002-be5a-000bcf47a832` | Bugs found during verification |
| System Architecture & AI Runtime | `4121f0a3fda78144a1befa9189ccc91e` | Runtime, provider rules, capability validation |
| Interview & Evaluation Design | `4121f0a3fda7819d8948cf1fbb726290` | Assessment units, rubric modes, async lifecycle |
| Data Model & Security | `4121f0a3fda78156a7cdd4838554f1b0` | 13-table logical model, security, retention, 5 diagrams |
| Architecture Decisions & Open Questions | `4121f0a3fda781ba8f36c2f55c065b4e` | ADR-001…030 + owner decisions + open items |
| Phase 0 & Development Plan | `4121f0a3fda781a7a11fe0f3a03ce18f` | Timeline, exit checklist, workstreams |
| Research & Academic Alignment | `4121f0a3fda7818bb84aecd8434aea87` | IR traceability, O4 evaluation rules |

Reading rules for agents and engineers:

1. Never treat a local doc as authority over a Notion requirement. If they conflict,
   raise it; do not silently resolve (AGENTS.md §3).
2. Do not create duplicate Notion pages, databases or diagrams. Update existing records.
3. Data dictionary v0.4 (`AIMIS_Data_Dictionary_v0.4.xlsx`, Notion Library) is the
   database schema baseline — derive Prisma migrations from it, do not redesign.
