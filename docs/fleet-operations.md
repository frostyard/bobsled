# Fleet operations visibility

The authenticated **Access** surface includes a read-only fleet-capacity projection. It answers what is currently queued or active without creating a scheduler or pretending that Bobsled enforces an organization-wide limit it does not yet have.

## Workload

The projection counts pending and active runs plus active attempts, reviews, and draft-publication lifecycles from the durable ledgers. Repository rows remain separate and the organization row is their aggregate. No task titles, model output, credentials, webhook bodies, or raw observation payloads are returned.

## Existing quota evidence

Multi-worker plans already snapshot bounded worker-attempt and Codex/Copilot call budgets. The fleet view totals only unexpired plan budgets and their durable attempt evidence, preserving the distinction between declared allowance and actual use. It does not invent a fleet-wide allowance from repository settings.

Migration 49 adds an append-only, versioned organization policy for maximum active workflows and concurrent Codex/Copilot calls. An authenticated operator may set or revise it from Access, with optimistic version and idempotency protection. The policy is deliberately reported as `enforcementMode: disabled`: recording a dashboard number must not imply scheduler authority. Enforcement activates only after every model-bearing path adopts one shared atomic capacity claim, preventing older intake, recovery, review, or multi-worker paths from bypassing the limit.

Migration 50 adds that shared observe-only claim ledger. The durable transition that marks a provider call consumed now creates its organization claim in the same SQLite immediate transaction; terminal settlement releases the slot in the same transaction as the source outcome. Claims bind their source lifecycle, owner, repository, provider slots, current policy version, observed occupancy, and whether the configured limit would have been exceeded. Reviews conservatively hold both a Copilot and Codex slot because one authorized lifecycle may enter its bounded remediation round. A source inventory test enumerates every Flue dispatch module so a new provider path cannot appear without an explicit claim mapping. The fleet view exposes only aggregate active claims and observed exceedances. Limits remain observe-only until claim expiry/recovery and live conformance are proven; migration 50 itself rejects no work.

## Retention

Flue observations currently have indefinite retention. The view exposes only total events, estimated stored bytes, and oldest/newest event timestamps. It cannot read raw payloads or delete, rotate, redact, or export evidence. Retention changes remain a separate versioned maintenance workflow with recoverable evidence handling.
