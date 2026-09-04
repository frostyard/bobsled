# Fleet operations visibility

The authenticated **Access** surface includes a read-only fleet-capacity projection. It answers what is currently queued or active without creating a scheduler or pretending that Bobsled enforces an organization-wide limit it does not yet have.

## Workload

The projection counts pending and active runs plus active attempts, reviews, and draft-publication lifecycles from the durable ledgers. Repository rows remain separate and the organization row is their aggregate. No task titles, model output, credentials, webhook bodies, or raw observation payloads are returned.

## Existing quota evidence

Multi-worker plans already snapshot bounded worker-attempt and Codex/Copilot call budgets. The fleet view totals only unexpired plan budgets and their durable attempt evidence, preserving the distinction between declared allowance and actual use. It does not invent a fleet-wide allowance from repository settings.

`concurrencyLimitConfigured: false` is intentional. A later boundary must add a durable, operator-managed organization policy and atomically enforce it before claims; changing a dashboard number alone must never imply scheduler authority.

## Retention

Flue observations currently have indefinite retention. The view exposes only total events, estimated stored bytes, and oldest/newest event timestamps. It cannot read raw payloads or delete, rotate, redact, or export evidence. Retention changes remain a separate versioned maintenance workflow with recoverable evidence handling.
