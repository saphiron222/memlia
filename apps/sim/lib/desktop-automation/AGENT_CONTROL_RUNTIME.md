# Dedicated agent control process

The existing workflow-worker image also builds `dist/memlia-agent-control.mjs` with Bun **target=node**. An operator runs the same admitted image with the command `node dist/memlia-agent-control.mjs`, as UID/GID1001 on Linux, in a separate process from the workflow worker and Next. The default worker command is unchanged. This addition does not enable a Compose service or qualify a production image, Windows agent or deployment.

`MEMLIA_AGENT_CONTROL_CONFIG` names one administrator-owned JSON file, captured once at module load. Missing/invalid configuration fails closed until restart, before opening a listener or loading DB. The internal alias of enrollment's protected descriptor reader enforces Linux identity, root-owned configuration/public certificates with non-writable ancestors and actual write-access denial, no symlinks/hardlinks, stable inode/ctime and bounded reads. Secret key/passphrase files belong to UID1001 (0400/0600) under a private0700 immediate parent and protected ancestors. No environment override weakens this policy.

Required shape (all properties mandatory; unknown fields refused):

```json
{
  "version": "memlia.agent-control-runtime/v1",
  "installation": {"id": "installation-id", "fqdn": "https://cabinet.example"},
  "controlOrigin": "https://control.example:9443",
  "listenHost": "0.0.0.0",
  "certificatePath": "/etc/memlia/control-leaf.pem",
  "certificateSha256": "<64 lowercase hex: exact PEM file>",
  "encryptedKeyPath": "/run/memlia/control/key.pem",
  "encryptedKeySha256": "<64 lowercase hex: encrypted PKCS8 file>",
  "passphraseFilePath": "/run/memlia/control/passphrase",
  "clientCaPath": "/etc/memlia/agent-client-ca.pem",
  "clientCaSha256": "<64 lowercase hex: exact PEM file>"
}
```

`installation.fqdn` is the enrollment origin, used with its exact installation ID in native peer authorization. `controlOrigin` is the separate canonical HTTPS listener origin; no credentials/path/query/fragment. Its port must be1024–65535 and is also the listening port; `listenHost` is an explicit IP literal. Configure DNS/firewall/trust externally; no forwarded certificate header, browser cookie or proxy principal can authenticate an agent.

One pinned server leaf and one pinned self-verifying client root CA are supported (no concatenated chains). The leaf must be currently valid, CA=false, serverAuth, exact SAN hostname/IP (no wildcard/CN fallback) and have the encrypted PKCS8 key pair. Its key must differ from the client CA's key: a CA private key must never be mounted to this process. The admin leaf pin is its authority; the client CA need not be its issuer. This profile requires clients to trust the server through their configured native trust, and does not install trust or rotate/revoke CAs. All certificates are rechecked at initialization and the process stops at their earliest expiry. The leaf passphrase is16–1024 UTF-8 bytes without NUL/CR/LF. Mutable input buffers are wiped after TLS creation; Node's TLS API requires an immutable passphrase string, whose native/JS copies cannot be reliably erased. Nothing is written to argv, logs, disk or an environment variable.

Only after TLS validation are the actual `@sim/db`, peer repository and durable control service imported. Native mTLS is mandatory; the repository rechecks cert/revocation/owner/workspace permission in each transaction. Artifact and control contracts remain unchanged. Configure the existing least-privilege web DB connection; no migration/DDL is performed and no Principal is fabricated.

SIGTERM/SIGINT stop this server only. New work is refused, owned sockets (including unfinished handshakes) are destroyed, and tracked peer/handler promises settle before primary/replica pools are ended once. A20-second drain deadline reports `control_unavailable_or_closure_unknown`; a referenced process-owned keepalive remains until network, pending work and DB closure are all acknowledged (also retained on drain rejection), and eventual cleanup continues, without claiming cancellation or calling `process.exit`. DB end uses the native5-second timeout. No second start or automatic effect retry exists. Only fixed status JSON is printed; no native exception/certificate/config values are exposed. There is no promise of Windows consent, business success or production mTLS qualification from these process tests.

New tests use real Node crypto and one real loopback mTLS composition, with explicit protected-file and DB doubles. Linux filesystem ownership and production Docker/Compose are not qualified by a Mac test. Node24 is required for execution: Bun's TLS implementation is not used. Node API references: https://nodejs.org/docs/latest-v24.x/api/tls.html#tlscreatesecurecontextoptions and https://nodejs.org/docs/latest-v24.x/api/crypto.html#class-x509certificate.
