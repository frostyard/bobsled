# Future explorations

These ideas are deliberately outside the committed roadmap. They preserve potentially useful directions without implying priority, schedule, or authorization to implement them. Promote an exploration into `ROADMAP.md` only after its unknowns are reduced and an operator deliberately chooses the work.

## User-bound inference authority

### Question

Should an authenticated Bobsled operator connect their own Codex and Copilot OAuth subscriptions so interactive runs consume inference under that operator's identity instead of a shared service credential?

The credential itself would remain server-side. Trusted code would associate a provider connection with the operator's immutable GitHub principal ID, and each admitted run would snapshot an `InferencePrincipal` reference. Browsers, agents, and workspaces would never receive token values or select arbitrary credential owners.

### Potential benefits

- Attribute inference usage, quota pressure, refresh failures, and revocation to the initiating operator.
- Prevent one operator's subscription state from silently affecting another operator's work.
- Let audit and observability records identify the inference principal without containing credentials.
- Make a missing or disconnected subscription a typed capability block before model-token spend.

### Unattended work

Webhook and scheduled jobs have no logged-in operator. Repository policy would therefore need to select inference authority explicitly:

- `initiating_user` for interactive work; or
- `service_identity` for unattended organization-managed work.

There should be no implicit fallback between them. A missing connection should remain recoverable through relinking, policy change, or supersession rather than an unbounded retry loop.

### Required spike

Before designing credential storage, prove that Flue and Pi can resolve provider authentication per run without cross-user leakage. The current implementation registers providers globally and protects one service-owned Pi credential file. The spike should determine whether run-scoped resolution is supported directly or requires a bounded adapter, and it should reject designs that dynamically accumulate global provider registrations per user.

### Open questions

- How are OAuth login, callback/device state, refresh locking, revocation, and reconnect bound to the authenticated Bobsled session?
- Should credentials use encrypted database rows, an operating-system secret store, isolated per-principal files, or another replaceable backend?
- What happens to queued and active jobs when a connection expires or is revoked?
- Can implementation and adversarial review use different inference principals while preserving understandable ownership and quota attribution?
- How does an operator inspect connection health without exposing provider identity details or token metadata unnecessarily?
- How would existing service-owned credentials migrate without cloning refreshable state or interrupting current private operation?

### Promotion criteria

Consider roadmap promotion only after a spike demonstrates run-scoped provider isolation, bounded refresh concurrency, explicit interactive/unattended policy, safe revocation behavior, credential-free agent environments, and a migration path that preserves the Prime Directive.
