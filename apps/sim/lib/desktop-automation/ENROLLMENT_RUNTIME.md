# Protected enrollment runtime composition

`getEnrollmentOrigin(): string | null` reads and caches only the administrator configuration.
`getEnrollmentService(): Promise<ReturnType<typeof createEnrollmentService> | null>` initializes
one native authority and service, lazily. Browser create/revoke routes require their native session
before requesting the service; workspace authorization follows inside the existing use case. Agent
challenge/complete routes carry no session principal: after native rate limiting and parsing, the
service checks the one-shot code and cryptographic proof. This module does not create a principal,
read client headers or grant enrollment authority from a workspace/client-supplied field.

`MEMLIA_AGENT_ENROLLMENT_CONFIG` is captured at module load; it names an absolute canonical
configuration path. Missing/invalid configuration or failed authority/service initialization stays
closed until process restart. There is no request-time configuration, fallback CA or retry.
Origin lookup does not read the passphrase, initialize OpenSSL, import the service or access DB.

The JSON schema is strict: version `memlia.agent-enrollment-runtime/v1`,
`installation:{id,fqdn}`, `openssl:{path,sha256,administratorGroupIds?}`,
`caCertificatePath`, `caCertificateSha256`, `encryptedKeyPath`, `passphraseFilePath`,
`spoolDirectory`, `certificateDays` (1..30). `fqdn` is the exact canonical HTTPS origin,
including a nondefault port if needed, without credentials, path, query or fragment. Digests are
64 lowercase hex characters. All paths are absolute and normalized. No inline passphrase or
private-key material belongs in JSON, environment, command arguments or logs.

Production requires Linux UID/EUID/GID/EGID1001. The configuration and every ancestor must be
root-owned, without group/other writes, and actually nonwritable by that runtime identity
(including ACLs). No root service or Mac override is provided. Configuration reads are capped at
8192 bytes and decoded as fatal UTF-8. The bounded descriptor pattern is reused from
`chat-policy-source.server.ts`: NOFOLLOW/NONBLOCK, regular single-link file, stable
inode/device/owner/mode/size/ctime/mtime and closed descriptor before accepting the observation.

The passphrase file is separately service-owned, mode0400 or0600, beneath an immediate
service-owned0700 directory. Ancestors remain root/service-owned without group/other writes;
root ancestors also undergo the effective write-access refusal. Secret bytes are16..1024 bytes,
without NUL/CR/LF. They are read only on service initialization and zeroized once the native
factory has captured its own copy, including failures. The native authority retains responsibility
for its protected CA certificate/encrypted key/spool, executable identity, native diagnostics and
issuance lifecycle. A failed service composition closes the created authority. The authority copy
lives for the process lifetime; this slice does not claim hot reload or secret rotation.

Tests double OS/filesystem/authority/service boundaries. They verify refusals, single initialization,
immutability and zeroization without a privileged filesystem, database or signer. They do not
qualify Linux root configuration, the production Docker/OpenSSL composition, mTLS ingress,
Windows enrollment, CA rotation or a complete agent journey. Existing native CA proofs remain
attached to their exact source and fictive fixtures; none is reassigned by these runtime tests.
