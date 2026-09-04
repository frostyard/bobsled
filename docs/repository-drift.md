# Repository enrollment drift

The authenticated **Access** surface shows the latest retained check for every repository in Bobsled's versioned enrollment registry. Page loads are side-effect-free. **Check repository drift** explicitly performs the bounded metadata reads and appends migration-48 observation evidence.

The runtime registry is durable SQLite state. Migration 47 imports the three previously reviewed source declarations once, records append-only bootstrap events, and never replays them after the migration marker exists. Current policy records are schema-validated and digest-checked on read. Later enrollment, disablement, or policy changes can therefore be explicit versioned actions without editing application source or deploying Bobsled.

For each repository, Bobsled mints a short-lived installation token scoped to that repository's immutable GitHub ID and the `metadata:read` permission. It fetches `/repositories/{id}` and compares only:

- immutable repository identity;
- canonical `owner/name`;
- default branch;
- archived state; and
- disabled state.

The projection also includes a SHA-256 fingerprint of the complete declared repository policy and bounded booleans for read-only, execution, review, publication, and multi-worker policy. It does not return the numeric GitHub repository ID, token, installation permissions, or raw upstream error body.

`aligned` means every observed field matches the declaration. `drifted` names the mismatched fields. `unavailable` means installation authority, GitHub access, or a valid metadata response was unavailable; it does not guess that the repository is healthy.

Each observation is bound to the exact retained enrollment version and policy digest. The current projection also counts open, non-archived runs whose immutable policy snapshot differs from the current enrollment and exposes at most 20 run IDs for inspection. Merged or closed publications, resolved stale-publication supersessions, verified no-change outcomes, and archived work do not create current policy-impact noise.

This check does not enroll, disable, rename, or otherwise mutate a repository. It creates no run, workspace, model call, scheduler claim, policy update, or GitHub write. Repository management is a separate confirmed Access-surface workflow: discovery and identity come from GitHub, policy comes from `.bobsled/repository.json`, and enroll/disable/re-enable actions append versioned registry evidence. Remediation of detected drift remains an explicit later action.
