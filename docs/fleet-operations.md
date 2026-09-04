# Fleet operations visibility

The authenticated **Access** surface includes a read-only fleet-capacity projection. It answers what is currently queued or active without creating a scheduler or pretending that Bobsled enforces an organization-wide limit it does not yet have.

## Workload

The projection counts pending and active runs plus active attempts, reviews, and draft-publication lifecycles from the durable ledgers. Repository rows remain separate and the organization row is their aggregate. No task titles, model output, credentials, webhook bodies, or raw observation payloads are returned.

## Existing quota evidence

Multi-worker plans already snapshot bounded worker-attempt and Codex/Copilot call budgets. The fleet view totals only unexpired plan budgets and their durable attempt evidence, preserving the distinction between declared allowance and actual use. It does not invent a fleet-wide allowance from repository settings.

Migration 49 adds an append-only, versioned organization policy for maximum active workflows and concurrent Codex/Copilot calls. An authenticated operator may set or revise it from Access, with optimistic version and idempotency protection. The policy is deliberately reported as `enforcementMode: disabled`: recording a dashboard number must not imply scheduler authority. Enforcement activates only after every model-bearing path adopts one shared atomic capacity claim, preventing older intake, recovery, review, or multi-worker paths from bypassing the limit.

## Retention

Flue observations currently have indefinite retention. The view exposes only total events, estimated stored bytes, and oldest/newest event timestamps. It cannot read raw payloads or delete, rotate, redact, or export evidence. Retention changes remain a separate versioned maintenance workflow with recoverable evidence handling.
