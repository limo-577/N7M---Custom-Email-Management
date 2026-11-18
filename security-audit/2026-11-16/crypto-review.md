# Crypto, backup and edit-session review

Date: 2026-11-16 (Europe/Rome). Reviewed `electron/vault.cjs`, `argon2.cjs`, `argon2-worker.cjs`, `backup.cjs`, `edit-sessions.cjs` and related tests. No real userData or credentials were used.

## Fixed: asynchronous Argon2 termination released the authentication slot early

- Severity: Low; availability/resource-boundary hardening. No remote exploit chain or actual OOM was demonstrated.
- Original location: `electron/argon2.cjs:14` (termination fire-and-forget), combined with the `VaultStore.authentication` finally block releasing `authBusy` when the derivation promise settles.
- Condition: repeated cancellation/retry, or a new derivation following a completed derivation while its worker is still shutting down. A deterministic fake-worker reproduction completed five cancellation promises before any of the five termination promises resolved. It allocated no real workers or WASM memory.
- Change: await `worker.terminate()` before resolving/rejecting derivation; retain the outer authentication gate until worker cleanup completes. If locking occurs while a successful key is waiting for termination, clear that pending key and reject. The fixed KDF parameters and file formats were not changed.
- Added four deterministic lifecycle regressions to `tests/vault-backup.test.cjs`: authentication gate on cancellation, successful-result lifetime and owned buffers, late cancellation during successful cleanup, and timeout/error cleanup without raw error leakage.
- Validation: `node --test --test-concurrency=1 tests/vault-backup.test.cjs tests/vault.test.cjs tests/edit-sessions.test.cjs` passed 28/28, exit 0, in about 85 seconds. The command includes legacy migration, backups, password rotation, locking and the new fake-worker regressions.

Node documents that Worker termination is asynchronous, and that `resourceLimits` applies to the JS engine rather than external ArrayBuffers: [official Worker documentation](https://nodejs.org/api/worker_threads.html). Thus the worker's 128 MiB old-generation heap setting is not a total-process/WASM memory limit; the fixed Argon2id allocation is 256 MiB.

## Fixed: backup imports did not enforce the documented 40 MiB decoded budget

Backup plaintext size is documented as 40 MiB, and export encryption already enforced this. The original import path only bounded the serialized envelope at 64 MiB and did not separately limit decoded ciphertext to 40 MiB. A crafted authenticated backup could therefore approach 48 MiB plaintext. This is a bounded Low validation/documentation gap, not evidence of unbounded allocation or RCE; import also requires current-vault reauthentication.

With the integrating agent's authorization, `parseEnvelope` now enforces `MAX_BACKUP_PLAINTEXT_BYTES` (40 MiB) only for `N7M-BACKUP`. GCM ciphertext and plaintext have equal length. Base64 length and padding reject over-budget data before decoding or KDF work, followed by an actual decoded-Buffer length check. Existing vault format/size compatibility and KDF parameters remain unchanged.

A boundary regression accepts exactly 40 MiB, rejects one additional byte despite equal base64 string length, and confirms the old scrypt vault parser still accepts that adjacent size. It uses zero-filled boundary data only, does not decrypt it or write it to disk, and is not a resource-exhaustion sample. The targeted boundary regression passed 1/1. After this second change, `node --test --test-concurrency=1 tests/vault-backup.test.cjs tests/vault.test.cjs tests/edit-sessions.test.cjs` passed 29/29, exit 0, in about 100 seconds; this is the final related-module regression result for both fixes.

## Confirmed controls and limits of the review

- KDF parameters are allowlisted exactly; file-provided parameters cannot enlarge the Argon2 or legacy scrypt budget.
- GCM AAD separates vault/backup domain, format version and KDF parameters; salt/IV/tag lengths and canonical base64 are checked.
- Backup exports reauthenticate, use a fresh random salt/nonce and omit machine-local window identity/migration metadata. Historical external backups intentionally retain their export-time password.
- Generation checks and authentication serialization protect password changes, backup operations and lock transitions. Edit capabilities bind sender, generation, selected IDs and expiration; field baselines use keyed HMAC and validate conflicts without retaining plaintext baselines.
- No additional confirmed confidentiality/integrity bypass was found in this assigned module scope. This is not a cryptographic proof or an audit of all third-party WASM internals. Main-process IPC and browser/UI review are handled separately by the integrating agent.
