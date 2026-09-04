# Repository enrollment drift

The authenticated **Access** surface performs a bounded, read-only check for every repository in Bobsled's versioned enrollment registry.

The runtime registry is durable SQLite state. Migration 47 imports the three previously reviewed source declarations once, records append-only bootstrap events, and never replays them after the migration marker exists. Current policy records are schema-validated and digest-checked on read. Later enrollment, disablement, or policy changes can therefore be explicit versioned actions without editing application source or deploying Bobsled.

For each repository, Bobsled mints a short-lived installation token scoped to that repository's immutable GitHub ID and the `metadata:read` permission. It fetches `/repositories/{id}` and compares only:

- immutable repository identity;
- canonical `owner/name`;
- default branch;
- archived state; and
- disabled state.

The projection also includes a SHA-256 fingerprint of the complete declared repository policy and bounded booleans for read-only, execution, review, publication, and multi-worker policy. It does not return the numeric GitHub repository ID, token, installation permissions, or raw upstream error body.

`aligned` means every observed field matches the declaration. `drifted` names the mismatched fields. `unavailable` means installation authority, GitHub access, or a valid metadata response was unavailable; it does not guess that the repository is healthy.

This check does not enroll, disable, rename, or otherwise mutate a repository. It creates no run, workspace, model call, scheduler claim, policy update, or GitHub write. Repository management is a separate confirmed Access-surface workflow: discovery and identity come from GitHub, policy comes from `.bobsled/repository.json`, and enroll/disable/re-enable actions append versioned registry evidence. Persisted drift-observation history and explicit handling for policy changes that affect admitted or unattended work remain later M8 work.
