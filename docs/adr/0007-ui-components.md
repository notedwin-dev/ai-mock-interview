# 0007. UI components: Tailwind 4 + shadcn-style copy-in primitives

Date: 2026-11-13
Status: Accepted
Notion mapping: NFR-USE-001…008; TT-2 wireframe, TT-6 dashboard, TT-8 interview room

## Context

The UI must deliver a meeting-style interview room, a three-row capability
configuration surface with per-row Custom forms, dashboards, reports and role-based
navigation — under a 30-day window and an AI-agent-heavy workflow. Approved styling is
Tailwind CSS 4 (IR §2.4.5). Heavy component frameworks add opinionated styling and
upgrade risk; hand-rolling every dialog/dropdown/popover is slow and error-prone for
accessibility (NFR-USE-008).

## Decision

- Use the **shadcn/ui pattern**: copy-in components generated into `src/components/ui/`
  from Radix primitives + Tailwind, with `lucide-react` icons. The code lives in the
  repo (no UI framework dependency to track), fully themeable with Tailwind 4.
- Add components on demand per feature — no bulk generation.
- Domain components (`src/components/interview/`, `src/components/provider-config/`)
  compose the primitives; no global state library — server components + local state +
  small hooks.

## Alternatives considered

- Full component library (MUI/Chakra/Ant): styling conflicts with Tailwind 4, larger
  bundle, more upgrade risk.
- Pure hand-rolled Tailwind: accessibility and interaction details (focus traps,
  comboboxes for model selectors) cost time we do not have.

## Consequences

- Consistent accessible primitives with zero runtime framework lock-in.
- Accepted: some copy-in code to maintain — bounded because only used components enter.
- Follow-up: TT-2 wireframe must specify the capability-row interaction states
  (scanning / models found / test passed-failed / manual model_id entry) before the
  first `provider-config` components are generated.
