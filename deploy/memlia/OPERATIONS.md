# Linux operator commands

`operations.py` fills the operator command gap around the existing Compose model,
read-only `preflight.py`, native database bootstrap and migrations. It is for a
**dedicated Linux host, Python3.11+, root account and local rootful Docker daemon only**. It
never builds, downloads an image, modifies a global Docker context or deletes a
foreign volume. The administrator is trusted; Docker access itself is root
power. Paths, binaries and release identities are administrator configuration,
never model/tool-call inputs. Root-owned files cannot be replaced by a runtime
UID; this is not isolation against a hostile administrator.

This implementation and its tests do **not** qualify Docker, restore on Linux,
RPO24h/RTO4h, release signatures or business replay. Existing image admission,
licence, SBOM, provenance, TLS and bootstrap gates still apply. Image labels
alone are consistency checks, not an admission certificate.

## Protected configuration

Create three separate root-owned0700 directories outside the repository:
configuration, operation journal, encrypted backups. All ancestors must be real,
root-controlled and not group/world-writable. No symlinks, NFS/mapped volumes,
custom Docker volume drivers, tablespace symlinks or unlisted persistent mounts
are accepted. The Docker client and OpenSSL3 must already be installed through
an administrator-controlled package; configure their canonical absolute path
and independently verified SHA-256. No tool is installed by this CLI.

Store a root-only JSON file, at most8192bytes, in its own0700 parent:

```json
{
  "version": "memlia.operations/v1",
  "project": "memlia-cabinet0001",
  "configDirectory": "/etc/memlia-private/cabinet0001",
  "stateDirectory": "/var/lib/memlia-operations/cabinet0001",
  "backupDirectory": "/var/backups/memlia-private/cabinet0001",
  "source": "<40 lowercase hex digits of the admitted application release>",
  "migrationSource": "<40 lowercase hex digits of the admitted migrations image source>",
  "lockSha256": "<64 lowercase hex digits>",
  "tools": {
    "docker": {"path": "/usr/bin/docker", "sha256": "<64 lowercase hex digits>"},
    "openssl": {"path": "/usr/bin/openssl", "sha256": "<64 lowercase hex digits>"}
  },
  "recipientCertificate": "/etc/memlia-backup-recipient/recipient.pem",
  "recipientSha256": "<64 lowercase hex digits>",
  "maxBackupBytes": 21474836480
}
```

Place `compose.env` (0400/0600), policy/trust/configuration files and the complete
agent CA/revocation state under `configDirectory`. A backup includes this whole
directory. Only the public backup recipient certificate lives separately; keep
the **encrypted PKCS8 backup decryption key and passphrase offline and outside
this directory**. They are not generated or trusted by the command. No plaintext
key fallback. The decrypted archive and raw native diagnostics are0600 in a0700
journal; failures retain them privately for reconciliation. Successful backup or
restore removes its temporary plaintext archive. Removal is not secure erasure
on SSDs; encrypted host storage and offline encrypted retention are required.

Prepare `bootstrap/config.json` in a0700 directory and an empty0700
`bootstrap-journal` under configuration. Use the existing
[bootstrap schema](DATABASE_BOOTSTRAP.md); `stateDirectory` inside the container
is `/run/memlia-bootstrap/state`. Its five DSNs must exactly match Compose's
migrate/web/realtime/worker/transport DSNs. The bootstrap administrator JSON is
mounted only into the isolated provisioning container. Configure the DB hostname
as reachable on the existing Compose backend network (`db`), not localhost.
The Excel worker's native admission/socket prerequisite remains independently
configured; installation does not start that worker.

The CLI requires the release's existing `compose.yaml` and `compose.excel.yaml`.
The standard three named volumes are postgres_data, uploads and redis_data.
It checks image RepoDigests and source/lock labels; the migrations source label
must match `migrationSource`, while application source labels match `source`.
Both identities are retained in release receipts and the encrypted backup
manifest. Images must be locally present. DB/cache use the existing immutable digests. Bind-mounted configuration
must be within the protected configuration directory; the existing ephemeral
`/run/memlia-excel` host socket is excluded from backup.

## Installation and cold backup

```sh
python3 -I -B deploy/memlia/operations.py --config /etc/memlia-ops/operator.json install
python3 -I -B deploy/memlia/operations.py --config /etc/memlia-ops/operator.json backup
```

Initial install requires `source == migrationSource` before effects and refuses
existing project resources/volume names. It creates the Compose
containers, starts DB/cache, runs native bootstrap prepare, native migrations,
grants and verify, then starts web/realtime/cron with native health checks. It
leaves the workflow worker stopped until its separate admission and reconciliation
requirements are fulfilled. A timeout/unknown bootstrap is HOLD, not permission
to rerun migrations. HTTP/TLS and business behaviour are not inferred from health.

Backup stops producers first and DB/cache afterwards with bounded native stop.
It requires all project containers closed without OOM or kill-style exit and
rejects any other running consumer of the exact volumes. It snapshots the cold
PostgreSQL data directory (including roles, grants, migration ledgers, queue,
IR and execution records), uploads, Valkey and configuration/trust together. It
rejects symbolic/hard links, special files and changing snapshots. PostgreSQL
major version and DB image must stay exact for physical restoration.

Encryption uses OpenSSL3 CMS AuthEnvelopedData with AES-256-GCM, streaming to a
new0600 archive. This is authenticated encryption, not author signing: the
operator must retain the closed backup receipt and its exact archive hash in a
trusted location. The recipient certificate alone does not prove who created an
archive. No passphrase or configuration content is passed in argv/stdout. The
CLI prints only a closed status/action/journal identifier. Raw subprocess output
is bounded privately before checking exit status or parsing JSON.

The stopped services are not automatically restarted. Verify that no external
business operation was left uncertain before a deliberate operator restart.
Backup is one coherent local artifact, not proof of off-host retention or RPO.
Transfer it by the cabinet's existing protected backup mechanism, and test an
isolated restoration before relying on it.

## Restore into an empty, stopped installation

On an isolated replacement host with the exact admitted release, same project,
absolute configuration location and images, create the three empty protected
directories and operator JSON. Do not create/start application containers first.

```sh
python3 -I -B deploy/memlia/operations.py --config /etc/memlia-ops/operator.json restore \
  --archive /var/backups/memlia-private/cabinet0001/EXACT.cms \
  --archive-sha256 EXACT_TRUSTED_RECEIPT_HASH \
  --key /run/private-recovery/encrypted-key.pem \
  --passphrase-file /run/private-recovery/passphrase
```

Only paths, not secrets, appear in argv. The key and passphrase files and their
immediate parent must be protected. Authentication/decryption and complete
archive path/type/size validation precede extraction. Configuration is restored
only into an empty directory; the exact Compose model/images are checked before
creating empty volumes. Files use exclusive/no-follow writes, original numeric
UID/GID/modes and byte-hash readback. Nothing is extracted over existing content.
The services remain **stopped, HOLD** after successful restoration. All database
and queue history is preserved; no SQL rewrites force a job to look completed.

A separate operator reconciliation must account for in-flight/unknown external
operations and controller identity, rotate/revoke stale agent authority where
needed and authorize any replay. This CLI deliberately has no automatic resume
or `--force` bypass. Do not start a restored clone beside the original controller.

## N/N-1 container staging

After an exact closed backup, change only administrator-approved image digests
in `compose.env` and source/lock in the operator JSON, then:

```sh
python3 -I -B deploy/memlia/operations.py --config /etc/memlia-ops/operator.json update \
  --previous-receipt /var/lib/memlia-operations/cabinet0001/EXACT_BACKUP_ID/result.json
```

`rollback` uses the same safety boundary with the explicitly selected previous
release. Both require the backup archive still matching its closed hash, the
same project and stopped containers matching that backup release. They reject
changed migrations, PostgreSQL or cache images, or a changed `migrationSource`.
For an application-only update, retain the admitted migrations image and its
`migrationSource` while changing the application `source` and image digests.
This separation does not establish schema compatibility or authorize inverse
migrations. These operations only recreate stopped
containers; no migration, downgrade, runtime launch or queue replay occurs.
Application/data compatibility and reconciliation remain HOLD. A schema-changing
upgrade needs a separately reviewed migration/restore procedure; this command
never claims a safe inverse migration merely because an old image exists.

## Interruptions, bounds and diagnostics

The journal has an exclusive local lock and fsynced intent before effects. A
pending or HOLD result blocks subsequent commands. Preserve the journal and
resources; investigate native effects instead of deleting locks/results to retry.
There is no automatic rollback or destructive uninstall. Never use `down -v`.

The operation has a one-hour ceiling, individual command ceilings, bounded1MiB
private stdout/stderr and at least40GiB free on the work/backup volumes. Archive
size is administrator-bounded (1MiB–128GiB plus bounded metadata). Process groups
are newly owned, kept unreaped through termination, then checked closed; global
process-name kills are absent. Real HOME is preserved. Cancellation or output
overflow is HOLD. Docker daemon side effects can outlive a disconnected CLI;
therefore no failed command is treated as "nothing happened".

Tests exercise real local filesystem rules, archive/refusal/composition and an
explicit optional native OpenSSL fixture. Docker/Compose/root Linux remain
separate native qualification, not implied by doubles. OpenSSL reference:
https://docs.openssl.org/3.5/man1/openssl-cms/ .
