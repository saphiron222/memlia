# Native attempt claim — P03 persistence slice

Copyright (c) 2026 Memlia. All rights reserved.

This module claims one attempt on the existing `async_jobs` row admitted by
`admitPgBossJob`. It is not connected to `getJobQueue`, a consumer, an endpoint or a
business runner. No schema, scheduler, retry policy or transport behavior changes.

## Transaction and identity

`claimPgBossAttempt(tx, nativeJobId, deliveredEnvelope)` requires the caller's
native database transaction. It locks the row with `FOR UPDATE`, calls the reviewed
`readPgBossPublication` integrity check under that lock and compares the complete
canonical delivered envelope to that admission. Missing rows require reconciliation.
An envelope is data, **not authentication or authorization**. The future trusted
caller must resolve and recheck authority before any effect; metadata must never
be used to invent a principal.

Only a coherent `pending` row with zero attempts and `maxAttempts = 1` can become
`processing`. The compare-and-set records one attempt and UTC timestamps from the
database. The due-time check also uses the database clock, after acquiring the
lock, independently of the session timezone and the caller's clock.

The server generates a UUID v4 attempt token and stores `{ version: 1, token }`
inside `metadata.memliaPgBossAdmission.attempt`. Admission already rejects the
entire `memliaPgBossAdmission` root in caller metadata. This adds no competing
reserved key and changes none of the immutable admission identity. The token is
an internal ownership handle, not a credential to expose or accept in an API.
A claim and its token become durable only when the **outer transaction commits**;
a rollback revokes that tentative handle.

| Result | Meaning / future integration requirement |
| --- | --- |
| `claimed` | One committed database attempt can own subsequent persistence. Resolve authority and use the real native runner before any business effect. |
| `defer` with `runAt` | Nothing was started. Arrange a durable wake at the accepted time; never definitively acknowledge an early delivery. |
| `terminal` | A verified row is already completed, failed or cancelled, with a completion timestamp. No attempt starts. |
| `reconciliation_required` | Missing, already processing, previously attempted, unknown or inconsistent state. No blind replay or automatic reset. |

The current transport acknowledges a normally returning callback. **Do not wire
these results into such a callback yet**: defer/reconciliation/uncertain outcome
handling and durable wake/ACK policy are outstanding. The existing outbox respects
`availableAt`, but the transport itself carries no delay and this module creates
no later wake. Existing native retention may purge rows; absence after purge is
not evidence that re-execution is safe. There are no invented tombstones.

## Locked ownership guard, not finalization

`guardPgBossAttempt(tx, attempt)` takes the row lock in the caller's transaction.
It returns true only for a coherent processing row with the same attempt token,
one attempt, no completion/result/error, and a valid immutable admission. A false
result forbids the caller's write. Cancellation, a different token/status, a
rolled-back token or the wrong job ID cannot pass. Invalid input and integrity
conflicts raise fixed errors; database failures expose only
`claim_persistence_unknown` with acceptance `unknown`, never raw SQL/driver data.

The future native finalizer must call the guard and perform its native result and
status update **in that same transaction**. Calling the guard in a separate
transaction loses the protection. The function rejects the native autocommit
handle at runtime as well as in its type. Do not call external services, models,
or business callbacks while holding this lock. Tests use a fixture-only output
write plus rollback to prove the protected boundary; no product finalizer is
implemented here.

The guard captures the primitive job ID and token before its first wait. TypeScript
`readonly` does not freeze the caller's object at runtime. A writer must likewise
capture the identity once and use that same private copy for both the guard and
its protected update, rather than reading a caller-owned handle after waiting.

No lease expires and no processing job is reclaimed. An operator or future writer
must not reset a prior attempt or restore an old processing token after a terminal
state; arbitrary database state rewrites are outside this protocol. A status or
token change already committed causes the guard to refuse; concurrent cancellation
waits until a guarded transaction finishes. The lock cannot undo an external
effect or provide exactly-once delivery. Real cancellation propagation, business
result preservation, uncertain-effect reconciliation and all native backend
methods remain integration gates.

## Verification

The integration test requires a private environment file named by
`MEMLIA_QUEUE_ADMISSION_TEST_ENV_FILE`. It refuses missing configuration and a
`TEST_DATABASE_URL` without `_test_`, clears inherited production/replica/migration
URLs, and uses the dedicated app role. Never print that file. Run from the product
root using the admitted Bun runtime:

```sh
bun --no-env-file test apps/sim/lib/core/async-jobs/backends/pg-boss-claim.integration.test.ts
```

The PostgreSQL suite tests concurrent deliveries, caller rollback/revoked tokens,
future runAt, a non-UTC session with the real database clock, absent/invalid
identities, all terminal statuses, prior attempts/inconsistent pending rows,
delivery/payload conflicts, stale/wrong ownership, corrupt projection/autocommit,
a real lock timeout with bounded errors and a real waiting cancellation observed
through `pg_stat_activity`. It deletes only its unique fixture IDs. No business
runner, AI, production data or secret-dependent action runs. Native worker and
browser integration, full application typecheck and deployment remain untested
by this slice.
