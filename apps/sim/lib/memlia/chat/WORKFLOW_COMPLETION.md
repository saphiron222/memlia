# Workflow completion observations

The existing SSE `complete.status = complete` means the local stream finished. It does not mean the user's workflow request was fulfilled. `complete.response.workflow` adds a closed, versioned observation derived only from native server ports:

- `no_preparation`: no workflow preview or proposal was observed.
- `preparation_only`: previews were evaluated or refused, without a created proposal.
- `proposal_not_applied`: created proposals were skipped, with no application.
- `applied`: at least one native proposal application was observed; the counts include skipped proposals and the latest applied revision. This does not certify the entire request, graph correctness, or calculation.

`previews.evaluated` counts a returned native dry run, including one containing diagnostics. It never means valid code. `previews.refused` counts native preview refusals or rejected input wrappers. `proposals` counts only proposals received by the owned server callback and their verified native tool states, never model intent events or prose. Pending or contradictory observations cannot yield this completion receipt. The native activity snapshot must also be available and attest zero active dispatches before any terminal observation is published. Counts are nonnegative safe integers, consistent with the native configurable limiter; this metadata adds no new tool-call ceiling. Existing local admission limits remain unchanged. Snapshots contain no body, code, IDs, secrets, or arbitrary tool output.

`workflowExecutionByThisChatBackend: not_performed` refers only to this local Chat backend's capabilities during the run. It says nothing about calculations or tests performed elsewhere. Human consent, exact digest, revision, scope, and the existing typed model-call-limit terminal remain unchanged.

An owned preview binding with a proposal port adds `nextStep.kind = review_diagnostics_then_propose_or_clarify` and names the actually exposed proposal tool. This is navigation, not validation or authorization. Without that binding no proposal next step is emitted. Diagnostic availability and best-effort limits are unchanged.

Clarifications and descriptive replies remain possible, including after an exploratory preview. Their meaning is not inferred from text. There is no model completion declaration, prose classifier, forced proposal, additional model call, or automatic application. The metadata uses the existing generated SSE `response` extension; no UI rendering of this observation is claimed here. Historical V7 remains failed; this change does not establish that a model will choose the required proposal tool. Native-provider tests use HTTP doubles and DB/permission boundaries are explicit doubles, not a paid-model or database qualification.

## Model turn finish observation

`complete.response.modelTurn.finishReason` is separate from the transport status and `response.workflow` effects. It carries only the final provider turn's closed `AgentStreamEvent` observation: `end_turn`, `stop_sequence`, or `max_tokens`. `max_tokens` means the provider reached its output limit; the text can be empty or partial and is not a complete synthesis. A natural provider stop also does not prove fulfillment of the user's request. A settled stream still closes through the existing `complete` transport event. No retry or automatic proposal follows.

`not_observed` means no final provider reason was available, including legacy adapters and the existing deterministic terminal after a certain applied edit at the model-call ceiling. It does not infer a natural stop. Intermediate `tool_use` observations never become a final model reason. Unknown or contradictory turn/reason combinations are rejected without exposing raw provider values. Other providers can continue emitting the unchanged event shape without this optional field.

An output limit after a verified application preserves the exact native `workflow` receipt and revision. It neither denies that edit, repeats it, nor certifies graph correctness or calculation. Partial tool calls remain refused by the native Anthropic loop and usage settlement remains unchanged. This metadata is observable by the local Chat driver/SSE contract; UI rendering is not qualified here. The native SDK regression uses a doubled HTTP response, not a paid model. Historical V8's stop reason remains unknown because it was not retained in its native ledger/events.
