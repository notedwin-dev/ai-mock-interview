# 0006. Argon2id via @node-rs/argon2

Date: 2026-11-13
Status: Accepted
Notion mapping: ADR-021, ADR-0025 (one role/account), NFR-SEC-003, FR-AUTH-001/002

## Context

Approved decision ADR-021: store a required password hash using Argon2id "or an
equivalent adaptive hash", never reversible encryption. The runtime is Node 22 in an
Alpine container; `node-argon2` compiles native code (node-gyp) on install, while
`@node-rs/argon2` ships prebuilt binaries (including musl for Alpine).

## Decision

Use `@node-rs/argon2` for password hashing/verification with Argon2id defaults
(memory/time cost from the library's secure defaults; re-evaluate parameters before
feature freeze). Auth.js v5 credentials provider calls `verify()` inside `authorize()`;
registration hashes on the server only.

## Alternatives considered

- `node-argon2`: native build on Alpine (musl) adds CI/Docker fragility.
- bcrypt/scrypt: allowed by "equivalent", but Argon2id is the explicitly named choice.

## Consequences

- No node-gyp in the image; faster installs.
- Accepted: Rust prebuilds track Node major versions — bump on Node upgrades.
- Follow-up: TT foundation task (auth) implements registration/sign-in/reset flows and
  tests hash round-trip plus wrong-password rejection.
