# 0005. AES-256-GCM encryption for user provider credentials

Date: 2026-11-13
Status: Accepted
Notion mapping: ADR-008, NFR-SEC-004/005, Data Model & Security (encrypted_api_key,
encryption_key_version)

## Context

`user_provider_configuration.encrypted_api_key` stores user-supplied (BYOK) provider
keys. Approved rules: encrypted at rest with a master key stored **outside the
database**; write-only from the UI; never returned after save; never logged; key
rotation supported via `encryption_key_version`.

## Decision

- Node `crypto` AES-256-GCM: random 12-byte IV per encryption, auth tag stored with
  the ciphertext (`v<version>:iv:tag:ciphertext` envelope format).
- Master key: `PROVIDER_ENCRYPTION_MASTER_KEY` (32 bytes, base64) from the
  environment; the active version in `PROVIDER_ENCRYPTION_KEY_VERSION` is written to
  the row on save.
- Decryption only inside the provider configuration service, immediately before an
  outbound server call; plaintext never cached, logged, or returned to any client.
- Rotation: new key ⇒ new version; rows re-encrypt lazily or by a migration job; the
  old key remains available until no row references its version.

## Alternatives considered

- Database-level pgcrypto: key would live reachable from SQL, weakening "master key
  outside the database"; also complicates migrations.
- KMS/cloud secret manager: unnecessary cloud dependency for an on-prem Docker
  deployment (NFR-DEP-002).

## Consequences

- Keys are safe at rest in DB dumps/backups (backup expiry policy in RISKS.md).
- Accepted: master-key custody is operational — losing it loses provider configs
  (recoverable by users re-entering keys; interview data is unaffected).
- Follow-up: TT-10 implements with round-trip and tamper tests (auth-tag failure).
