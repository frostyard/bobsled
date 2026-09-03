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

### M2 — GitHub App and durable job ledger — `DONE`

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
- [x] Narrow the live GitHub App permissions to only those required by enabled capabilities.
- [x] Enroll Bobsled itself for issue metadata writes while worker execution, publication, and merge remain disabled.
- [x] Live-prove label/comment writes for an explicitly authorized repository while code publication remains disabled.

External-setup evidence: authenticated HTTPS operator access, signed ping and automatic installation webhook admission, invalid-signature rejection, idempotent redelivery, private-key-file rotation with the predecessor revoked, and post-revocation installation-token minting all passed on Linux. Organization-wide installation coverage is an accepted operator decision for near-term expansion; Bobsled's enrolled-repository policy remains the execution boundary. Event-driven dispatch and code publication remain disabled.

Permission-narrowing evidence: GitHub automatically delivered each reduction as a verified installation update, and the latest retained snapshot reports organization-wide repository coverage with no permission above Bobsled's declared capability ceiling.

Issue-action evidence: the explicitly authorized temporary [Bobsled issue #17](https://github.com/frostyard/bobsled/issues/17) received one bounded route label and one marker-bearing comment. A simulated interruption after GitHub accepted the comment left the durable action retryable; the next attempt recovered the existing marker without another comment POST, and subsequent label/comment execution made no additional requests. The issue was then closed, while worker execution, review, publication, force-push, and merge remained disabled by repository policy.

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
- [x] Enable publication for one explicitly authorized non-test repository.
- [ ] Live-prove draft branch/PR creation and observe required GitHub checks; human review and merge remain mandatory.

Acceptance target: `frostyard/frostyard-org` snapshots its immutable repository identity, runs `npm ci` before execution, requires `npm run ci`, sends successful patches through automatic fresh-context review, and may publish only generated non-force draft branches. Cloudflare's `Workers Builds: frostyard-org` check is required before handoff. Automation/deployment configuration is protected, and Bobsled retains no merge or deployment capability.

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

### M5 — Multi-worker plans — `DONE`

- [x] Represent work as a typed dependency DAG.
- [x] Assign non-overlapping file scopes to prospective parallel workers.
- [x] Bind trusted changed paths to each task's declared ownership before execution authority.
- [x] Define fail-closed integration assembly over trusted prerequisite patch evidence.
- [x] Apply digest-verified prerequisite patch stacks in an isolated worktree with conflict evidence.
- [x] Define one bounded integration-worker call and trusted postcondition disposition.
- [x] Persist a principal-scoped one-use invocation lease before model dispatch.
- [x] Attach immutable M5 plans, assemblies, and invocation leases to an owned durable job.
- [x] Run and persist required integration gates against the durable invocation lineage.
- [x] Require durable clean-stack preflight before an integration lease can be claimed.
- [x] Orchestrate one dependency-bearing invocation through worker evidence, trusted postconditions, and gates.
- [x] Run repository preparation and revalidate the final patch after integration gates.
- [x] Complete the separate conflict-resolution path for rejected prerequisite stacks.
  - [x] Preserve one principal-scoped Git three-way resolution attempt in a new immutable workspace.
  - [x] Promote a resolved stack through fresh trusted assembly evidence without rewriting rejected history.
  - [x] Reserve one principal-scoped model call for durable unresolved Git evidence, with no retry after claim ambiguity.
  - [x] Authenticate an ordered replay manifest and reproduce exact conflicts in a fresh prepared workspace before model claim.
  - [x] Add an optional bounded agent strategy for still-unmerged paths.
- [x] Bound fan-out, retries, runtime, and subscription usage.
  - [x] Snapshot repository-authored concurrency, attempt, retry, wall-clock, and provider-call budgets and enforce atomic workspace/dispatch claims.
  - [x] Schedule dependency-ready tasks through the durable budget without granting callers direct lease authority.
  - [x] Project budget exhaustion and active fan-out into durable operator evidence.

M5 DAG-contract evidence: version 1 remains readable and bounds task content/count, requires stable IDs and acceptance criteria, and rejects duplicate IDs/edges, missing targets, self-dependencies, and cycles. Version 2 adds literal file, directory-subtree, or repository-wide ownership; rejects ambiguous paths and redundant scopes; and permits overlap only when a transitive dependency orders the tasks. The deterministic readiness projection preserves declared order and explicitly grants no execution authority, fan-out, workspace lease, retry, or token spend. A separate typed disposition binds trusted Git changed paths to one version 2 task: exact file and directory-subtree ownership is enforced, invalid, duplicate, and outside-scope paths remain visible as deterministic violations, and unknown tasks or over-broad input fail closed. Integration assembly recomputes that scope authorization for the complete transitive prerequisite set, requires one base commit, and emits a deterministic topological patch stack only when no evidence is missing, duplicated, unrelated, mismatched, or out of scope. A bounded workspace service verifies payload identity and SHA-256 digests before mutation, applies the complete stack to a detached worktree, preserves explicit no-change prerequisites, recomputes actual paths and combined patch evidence, and blocks on conflicts without granting a worker call. A separate deterministic recovery strategy replays only a patch-rejected stack with Git three-way application in a new UUID-addressed worktree; it preserves the original failed workspace, records resolved output or exact unmerged paths under principal-scoped lineage, and makes zero model calls. Successful Git resolution is re-inspected against its base, staged digest, and clean worktree before a new immutable assembly identity can be promoted; failed inspections remain retryable as explicit superseding attempts, while one successful promotion may feed the existing invocation path. True conflicts may now reserve a principal-scoped agent invocation only from durable `unresolved_conflict` evidence. Migration 17 permits abandoned pre-dispatch attempts to be superseded but enforces one model-bearing claim per source resolution across processes; an ambiguous or failed claimed call consumes the allowance and cannot retry. Migration 18 retains a preparation-and-replay preflight before that claim: new three-way results authenticate the complete ordered patch manifest, the preflight reads only bounded regular evidence files with matching SHA-256 digests, creates a fresh detached worktree, runs the snapshotted repository preparation command, requires a clean unchanged base, and reproduces the exact applied prefix, failed task, and unmerged paths. Historical results without the manifest, tampered files, policy denial, preparation failure or mutation, and any replay drift block with zero model calls. Migration 19 attaches one native Pi/Codex conflict call to that passing preflight. The worker receives repository-wide read context but may edit and stage only the exact unmerged paths; trusted code revalidates replay state before claim, rejects moved HEAD, unresolved entries, non-conflict changes, duplicate or false path reports, unstaged files, marker residue, changed patch evidence, policy limits, and protected paths, then applies the authenticated remaining stack without another model call. Completed receipts, blocked dispositions, failures, and the promoted-compatible resolution are committed under the one-use lineage. Concurrent observers never duplicate the call, and expired ambiguity is terminal. This internal service still has no direct operator control, retry, fan-out, or GitHub capability. A native Pi/Codex integration runner separately makes one call per dependency-bearing task and requires prerequisite changes to remain staged while adding only unstaged task-scoped edits. Trusted disposition rejects moved HEAD, changed index digest, scope escapes, false path/disposition claims, inconsistent final paths or digests, aggregate size-limit breaches, and protected paths, and authorizes no follow-up. A principal-scoped one-use lease binds that invocation to its durable job, plan, and direct-or-promoted assembly parents. The snapshotted repository preparation command is serialized and recorded before preflight; failed, timed-out, or ambiguously interrupted preparation blocks with zero worker calls. Trusted preflight then derives the live workspace from durable lineage and requires the original HEAD, exact staged prerequisite digest, and no unstaged or untracked paths. The orchestration service reconstructs model input only from durable parentage, preserves the bounded native Codex receipt, inspects tracked and untracked output, stores trusted disposition, and continues successful work into required gates. After every gate sequence, a second trusted Git inspection rechecks HEAD, prerequisite index, worker paths, aggregate paths, limits, protected boundaries, and final patch digest; even all-passing gates cannot settle success if they altered the deliverable. Concurrent observers do not duplicate preparation or disturb an in-flight worker call; expired ambiguous claims fail without retry. Direct invocation controls, retry, and dispatching fan-out remain disabled.

Migration 20 adds the dormant factory budget boundary. New repository snapshots declare whether multi-worker execution is enabled plus maximum concurrent workspace attempts, total attempts, zero-call pre-dispatch retries per task, elapsed wall-clock runtime, and provider-specific Codex/Copilot calls. A plan snapshots that policy into one durable budget before any attempt may start. Immediate SQLite write transactions atomically reserve concurrency and retry slots across processes; a separate dispatch claim consumes the provider allowance immediately before Pi submission. Only a terminal pre-dispatch failure with zero model calls may retry. Once a model call is claimed—or its outcome is ambiguous—the task cannot retry. Current repository policies keep this capability disabled, and no scheduler, fan-out, UI action, or additional model call is introduced by this migration.

The dependency-ready scheduler now projects the immutable plan and budget ledger into deterministic task states. It reserves roots and newly unblocked descendants in declared order up to the snapshotted concurrency limit, propagates terminal prerequisite failures transitively, and permits only same-provider retries after durable zero-call pre-dispatch failures. Deterministic attempt identities plus an atomic `newlyReserved` result prevent idempotent cross-process replay from authorizing duplicate workspace creation. The scheduler selects the native Codex provider internally and always reports `executionAuthorized: false` and `modelDispatchAuthorized: false`; it creates no workspace, makes no model call, exposes no HTTP/UI action, and remains inert under the current disabled repository policies.

The authenticated operator board now joins each run through its owned job to the latest immutable multi-worker plan and read-only budget ledger. Cards show active workers, task completion, attempts, provider-call use, deadline, dependency blocks, and exhausted-budget reasons; active work projects into `Working`, while terminal exhaustion projects into `Attention`. The projection opens a short-lived read-only SQLite connection, never calls the scheduler, never reserves an attempt or provider slot, and always reports execution and dispatch authorization as false. Historical plan snapshots without multi-worker policy fail closed instead of blanking the board. Current repository policies still keep actual fan-out disabled.

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

- Public ingress is bounded by Frostyard GitHub operator authentication and verified webhooks; event-triggered dispatch remains disabled, and GitHub mutations require explicit enrolled policy plus the durable action outbox.
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
