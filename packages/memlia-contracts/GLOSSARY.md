# Memlia execution contracts

Terms distinguishing authority, intent and observed effects across the product.

## Language

**Actor**: The identity that triggers an operation, including an automated service.
_Avoid_: Owner when describing who initiated a run.

**Subject**: The user or approved service account whose bounded authority permits a run.
_Avoid_: Payer as an authority source.

**Binding**: An approved logical connection to a provider account in a trust zone.
_Avoid_: Token.

**Delegation**: A revocable grant permitting a service to act for a subject under explicit restrictions.
_Avoid_: Simulated browser session.

**Proposal**: A specific set of intended changes against a known resource revision.
_Avoid_: Applied change.

**Approval**: A person's consent to one exact proposal and destination for a limited time.
_Avoid_: General permission.

**Snapshot**: An observation of a workbook before mutation, including its values and formulas.
_Avoid_: Backup, unless a separately persisted restorable copy has been verified.

**PatchSet**: The bounded proposed mutations, or an explicit empty no-changes observation, derived from a particular snapshot and procedure version.
_Avoid_: Transaction.

**Receipt**: An account of observed execution and its evidence, including partial or uncertain effects.
_Avoid_: Success when verification is incomplete.

**No changes verified**: A successful observation that the workbook already satisfies the procedure, with evidence and no applied mutation.
_Avoid_: Written or saved when no write occurred.
