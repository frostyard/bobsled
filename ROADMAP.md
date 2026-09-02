# Bobsled Factory Roadmap

This is the public project-status record. It describes product capabilities and safety boundaries without deployment-specific identifiers or private run evidence.

Status: `DONE` · `ACTIVE` · `NEXT` · `PLANNED` · `BLOCKED`

## Northstar

Bobsled is a trusted software-development and maintenance control plane for the Frostyard GitHub organization. It turns repository events and operator intent into schema-validated jobs, runs workers in bounded workspaces, obtains independent review, proves repository-declared quality gates, and opens pull requests for human review. Bobsled never merges its own work.

Linux is the canonical production runtime. Multi-repository changes are a first-class destination: one change set may coordinate ordered work and compatible pull requests across several repositories while preserving each repository's policy and gates.

## Milestones

### M0 — Subscription-backed Flue runtime — `DONE`

- Flue v2 on Node.js.
- Native Pi OAuth providers for Codex and GitHub Copilot subscriptions.
- Cross-process-safe credential login and refresh.
- Standalone Codex and Copilot agents plus a Codex-led Bobsled team.

### M1 — Typed control plane and read-only triage — `DONE`

- Schema-validated repository, intake, triage, gate, and policy contracts.
- Enrolled-repository registry with read-only GitHub issue intake.
- Sandboxed triage with no GitHub mutation capability.
- Operator interface for repository selection, issues, manual tasks, and dry-run triage.

### M2 — GitHub App and durable job ledger — `ACTIVE`

- [x] Durable runs, attempts, artifacts, approvals, audit events, cancellation, supersession, and human override.
- [x] Verified and deduplicated webhook admission with exact-input retention.
- [x] Complete in-process Flue observation retention with aggregate-only HTTP status.
- [x] Disabled-by-default GitHub operator authentication with organization membership checks and durable sessions.
- [x] Repository-scoped installation-token profiles and a policy-first label/comment outbox.
- [x] Define a public-safe Caddy TLS boundary, raw-agent-route denial, and fail-closed activation sequence for the production hostname.
- [x] Preserve local-trusted history through an explicit, conflict-checked, audited GitHub-principal cutover.
- [x] Support fail-closed GitHub App private-key files so deployed PEM material bypasses dotenv and systemd parsing.
- [x] Complete the external HTTPS webhook and operator-authentication setup.
- [x] Surface effective permission drift from verified installation snapshots without minting a token or exposing raw authority.
- [ ] Narrow the live GitHub App permissions to only those required by enabled capabilities.
- [ ] Live-prove label/comment writes for an explicitly authorized repository while code publication remains disabled.

External-setup evidence: authenticated HTTPS operator access, signed ping and automatic installation webhook admission, invalid-signature rejection, idempotent redelivery, private-key-file rotation with the predecessor revoked, and post-revocation installation-token minting all passed on Linux. Organization-wide installation coverage is an accepted operator decision for near-term expansion; Bobsled's enrolled-repository policy remains the execution boundary. Event-driven dispatch and GitHub mutations remain disabled while the live permission grant is broader than the declared capability policy.

### M2-L — Linux deployment foundation — `DONE`

- Unprivileged Linux container and locked service account.
- Immutable application releases separated from credentials, databases, and workspaces.
- Narrow systemd write authority, health verification, and rollback support.
- Host-native Codex and Copilot OAuth; refreshable credentials are never cloned between machines.

### M3 — One-click single-repository fixes — `DONE`

- Explicit `Go fix this` authorization with owner and version checks.
- Disposable Git worktree and private sandbox home per attempt.
- Repository-declared preparation command and required quality gates.
- Schema-validated Codex implementation plans and results.
- Trusted patch computation, protected-path enforcement, size limits, and unchanged-HEAD checks.
- Durable plans, logs, gate results, patches, digests, and failure evidence.

### M4 — Independent review and draft PR publication — `ACTIVE`

- [x] Automatic fresh-context Copilot review over an immutable, read-only repository snapshot.
- [x] At most one bounded Codex remediation round followed by a new independent verdict.
- [x] Durable findings, verdicts, evidence, publication intent, and required-check state.
- [x] Exact-patch-bound, draft-only publication with deterministic Git objects and no force push.
- [x] Five-lane operator board with card actions, evidence details, and documented lane criteria.
- [x] Bounded authenticated-operator identity chip in the board header without exposing immutable IDs, roles, or session metadata.
- [ ] Enable publication for one explicitly authorized non-test repository.
- [ ] Live-prove draft branch/PR creation and observe required GitHub checks; human review and merge remain mandatory.

### M4-R — Standalone public repository preparation — `DONE`

- [x] Move live credentials, databases, and disposable workspaces outside the source tree.
- [x] Preserve private deployment/run history outside the public repository.
- [x] Generalize public deployment documentation and remove private identifiers.
- [x] Add project metadata, license, placeholder configuration, security/contribution guidance, and CI.
- [x] Harden ignore rules and add automated secret scanning.
- [x] Initialize Bobsled as a standalone Git repository.
- [x] Inspect the exact first-commit candidate and verify tests, build, package contents, dependencies, and secrets before publication.

Readiness criterion: the repository contains only intentional public source, tests, templates, and generalized documentation. No credential, runtime database, embedded checkout, private infrastructure identifier, or private operational evidence is present in its first commit or history.

Readiness evidence: local credentials and runtime state resolve outside the repository, tests use an isolated temporary runtime, both subscription credentials remain readable through the protected external store, all 80 deterministic tests pass on the minimum supported Node release, type checking and the production build pass, the package candidate is bounded, the production dependency audit reports no known vulnerabilities, and Gitleaks reports no leaks. CI repeats verification across supported Node lines and scans complete Git history. The public repository is `frostyard/bobsled`; its first push passed every CI job and contained no forbidden sensitive path.

### M5 — Multi-worker plans — `ACTIVE`

- [x] Represent work as a typed dependency DAG.
- [ ] Assign non-overlapping file scopes to parallel workers.
- [ ] Add an integration worker for dependent or conflicting changes.
- [ ] Bound fan-out, retries, runtime, and subscription usage.

M5 DAG-contract evidence: the versioned runtime schema bounds task content and count, requires stable IDs and acceptance criteria, and rejects duplicate IDs/edges, missing targets, self-dependencies, and cycles. Deterministic dependency layers preserve declared order, but deliberately grant no parallel-execution authority before file-scope ownership exists.

### M6 — Multi-repository change sets — `PLANNED`

- Add a typed repository dependency graph and cross-repository change-set record.
- Plan version/API compatibility and rollout order across repositories.
- Maintain one isolated job, policy snapshot, gate set, branch, and PR per repository.
- Add cross-repository verification and a human-readable rollout/rollback plan.
- Publish linked draft PRs only after every required repository reaches a publishable state.
- Expose partial failure, retry, supersession, and rollback explicitly.

### M7 — Organization-scale operations — `PLANNED`

- Scheduled and webhook-triggered maintenance.
- Repository enrollment and policy drift detection.
- Fleet concurrency, quotas, observability retention, and operational dashboards.
- Human approval queues, notifications, and historical reporting.

## Current safety boundary

- Public ingress is bounded by Frostyard GitHub operator authentication and verified webhooks; event-triggered dispatch remains disabled until the live App permissions match capability policy.
- Repository policies and deterministic gates outrank model recommendations.
- Models cannot select arbitrary repositories or mutate repository policy.
- Raw Flue observations and verified webhook bodies are sensitive operational records and are not exposed through a content API.
- No automated merge, release, branch-protection change, or quality-gate weakening.
- Public ingress keeps its private Incus upstream as a rollback path; changing the host's live Ethernet topology is outside the application milestone.

## Prime Directive — preserve optionality

- Hard-stop credentials and irreversible or public side effects by default.
- Treat model classifications as advice, not authorization or permanent vetoes.
- Allow a human to override recoverable policy blocks with an explicit recorded reason.
- Preserve cancelled and failed history; create a superseding run rather than rewriting evidence.
- Surface missing capabilities before spending model tokens on impossible work.
- Version policies and snapshot them per job so later improvements do not invalidate old evidence.
- Prefer warnings and bounded continuation when the consequence is local and recoverable.
