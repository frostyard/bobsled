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

### M4 — Independent review and draft PR publication — `DONE`

- [x] Automatic fresh-context Copilot review over an immutable, read-only repository snapshot.
- [x] At most one bounded Codex remediation round followed by a new independent verdict.
- [x] Durable findings, verdicts, evidence, publication intent, and required-check state.
- [x] Exact-patch-bound, draft-only publication with deterministic Git objects and no force push.
- [x] Five-lane operator board with card actions, evidence details, and documented lane criteria.
- [x] Bounded authenticated-operator identity chip in the board header without exposing immutable IDs, roles, or session metadata.
- [x] Enable publication for one explicitly authorized non-test repository.
- [x] Live-prove draft branch/PR creation and observe required GitHub checks; human review and merge remain mandatory.

Acceptance target: `frostyard/frostyard-org` snapshots its immutable repository identity, runs `npm ci` before execution, requires `npm run ci`, sends successful patches through automatic fresh-context review, and may publish only generated non-force draft branches. Cloudflare's `Workers Builds: frostyard-org` check is required before handoff. Automation/deployment configuration is protected, and Bobsled retains no merge or deployment capability.

Live acceptance evidence: Bobsled triaged, implemented, gated, independently approved, and published [frostyard-org PR #6](https://github.com/frostyard/frostyard-org/pull/6) as a draft. The required Cloudflare Workers build passed, and a human merged the PR. A second approved change was correctly blocked when `main` advanced beyond its reviewed base; after the enrolled source was refreshed and the task rerun, Bobsled published [frostyard-org PR #7](https://github.com/frostyard/frostyard-org/pull/7), whose required Cloudflare check also passed.

Post-acceptance hardening:

- [x] Reconcile an externally closed or merged draft PR into durable publication and board state through the authenticated **Refresh status** action; closed PRs remain refreshable so reopening returns them to the correct delivery/check state.
- [x] When `main` advances cleanly after approval, reapply and revalidate the exact approved patch on the new base without another implementation-worker call; fail closed on conflicts or unverifiable context drift.
  - [x] Persist a principal-scoped superseding replay, authenticate the old patch and new base, reapply it in a fresh worktree, and rerun current preparation/gates with zero model calls.
  - [x] Run one fresh read-only adversarial review against the new repository snapshot, then promote only approved replay evidence into a new immutable publication intent.
  - [x] Add authenticated operator orchestration and board evidence for replay, fresh review, and promotion before live use.
  - [x] Retain an immutable zero-call supersession decision when a later human-merged publication already delivered the task and exact replay conflicts.

Live recovery evidence: the retained canonical/Open Graph publication entered the authenticated replay path after PR #44 deployment. Its first attempt correctly blocked because the trusted checkout was stale; after a clean fast-forward, a superseding replay authenticated the patch and current base, then retained an exact conflict in `src/layouts/Site.astro` with zero model calls. Website PR #7 had already delivered the same task with a different local identifier spelling, so no fresh review or duplicate recovered PR was authorized. Migration 25 records the explicit immutable supersession by that later merged publication instead of leaving the obsolete card permanently actionable.

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

### M6 — Multi-repository change sets — `ACTIVE`

- [x] Add a typed repository dependency graph and cross-repository change-set record.
- [x] Plan version/API compatibility and rollout order across repositories.
- [ ] Maintain one isolated job, policy snapshot, gate set, branch, and PR per repository.
- [x] Bind all completed member evidence into a human-readable compatibility and rollout/rollback plan.
- [ ] Execute cross-repository compatibility verification against that immutable plan.
- [ ] Publish linked draft PRs only after every required repository reaches a publishable state.
- [ ] Expose partial failure, retry, supersession, and rollback explicitly.

M6 contract evidence: version 1 bounds a change set to 2–16 distinct repositories, with one repository-scoped objective and acceptance-criteria set per participant. Dependencies use the shared deterministic DAG implementation, reject duplicate/missing/self/cyclic edges, and require exactly one typed compatibility contract for each direct dependency. Compatibility contracts classify API, schema, artifact, runtime, or documentation expectations and carry explicit verification criteria. Dependency-first layers preserve declared repository order. Readiness then verifies enabled enrollment and requires every participating repository pair—not only directly connected dependencies—to mutually allow coordination through `multiRepo.coordinateWith`. Violations remain typed evidence. Even a fully allowed plan explicitly grants no workspace, model-call, branch, publication, rollout, or merge authority.

Migration 26 adds that durable parentage without enabling execution. An idempotent, principal-scoped change-set row stores the canonical version-1 plan and digest. Each member receives one deterministic ledger run/job whose work item is derived from that repository's bounded objective and acceptance criteria; the run/job is deliberately admitted blocked, with zero attempts, because coordinated execution is not implemented. The member row duplicates and hashes its exact plan unit and immutable repository policy snapshot while referencing the original run/job. Every read recomputes the plan, unit, and policy digests and cross-checks the ledger owner, repository, and snapshot. Generic single-repository override, cancel, and supersede transitions reject linked member runs; future recovery must be an explicit coordinated action. Policy denial occurs before job creation; interrupted pre-parent admission reuses deterministic local job identities; changed idempotency input, duplicate plan parents, cross-principal reads, or tampered evidence fail closed. Current repository coordination allowlists remain empty, so production admission is dormant. No workspace, model call, gate, branch, publication, rollout, or merge authority is added.

Migration 27 adds the first explicit coordinated transition without making individual member jobs executable. One immutable, principal-scoped authorization binds the exact ordered member IDs, run/job IDs, unit digests, policy-snapshot digests, and plan digest. Admission rechecks current enabled enrollment and mutual pairwise coordination consent, then uses one immediate transaction to require every ledger parent to remain blocked with zero attempts, reviews, or artifacts before recording the decision. Exact replay converges across processes; competing decisions, changed idempotency input, revoked consent, cross-principal access, member-state drift, or stored evidence tampering fail closed. Unrelated current repository metadata does not invalidate the decision because later workspace/execution boundaries must independently revalidate their own current policy. Member runs remain blocked, generic single-repository transitions remain denied, and the authorization reports workspace, model-dispatch, and publication authority as false. Production coordination allowlists are still empty, so the path remains dormant.

Migration 28 adds that first execution-policy revalidation without granting execution. One principal-scoped, idempotent schedule rechecks current mutual consent, code-write capability, execution enablement, and required-gate references for every authorized repository. It snapshots each complete current repository contract under a fresh digest while retaining the original job policy as immutable admission history. Trusted dependency layers mark initial roots `eligible` and later repositories `waiting`; these states never mutate and grant no lease, so later orchestration must recompute readiness from durable prerequisite completion. The schedule is recorded in one immediate transaction only while every member run/job remains blocked with zero attempts, reviews, or artifacts. Exact replay converges across processes; competing schedules, changed input, policy denial, member drift, cross-principal access, or stored layer/member/policy tampering fails closed. Current coordination allowlists remain empty, and all member runs stay blocked with preparation, dispatch, publication, rollout, and merge authority false.

Migration 29 adds one expiring, principal-scoped member preparation lease per immutable schedule member and permits only one reserved member per change set schedule. Roots may reserve immediately; dependents require each direct prerequisite to have a succeeded run/job, a succeeded current attempt, and an approved review when the prerequisite's scheduled policy requires one. Reservation rechecks current mutual coordination, code-write capability, execution enablement, and required gates; snapshots the complete current target policy; derives expiry from the declared preparation timeout; and atomically requires the target member to remain blocked with zero attempts, reviews, or artifacts. Exact replay converges across processes. Premature dependencies, competing leases, policy denial, member drift, ownership mismatch, or stored evidence tampering fail closed. This is workspace-preparation authority only: it creates no workspace, runs no command, unblocks no member job, spends no subscription call, and grants no execution, GitHub, publication, rollout, or merge authority. Current production allowlists keep it dormant.

Migration 30 consumes that lease in a fresh detached worktree rooted beneath Bobsled's durable workspace directory. The source checkout must resolve beneath the trusted repository source root and be its Git top level; the member base is the snapshotted policy's local default-branch commit. Bobsled runs only the trusted snapshotted preparation command with the existing credential-free bounded command runner, then requires HEAD and all tracked/untracked paths to remain clean. Success records the base, workspace, preparation result, and zero-authority flags as one immutable `prepared` result. Missing sources, workspace collisions, command failure/timeout, changed files, moved HEAD, and inspection failures become bounded `blocked` evidence. An expired reservation creates no workspace, and an expired ambiguous preparation is failed closed without rerunning its command. Cross-process claim/settlement and stored result digests prevent duplicate commands or evidence replacement. Prepared work still cannot dispatch a model or mutate its blocked ledger job; an explicit execution transition remains required. Current production allowlists keep the path dormant.

Migration 31 adds a principal-scoped execution-preflight reservation for one successfully prepared member. It revalidates current mutual coordination and requires the current repository policy to exactly match the preparation snapshot, binds the preparation-result digest, base commit, workspace, and evidence paths, and atomically requires the member run/job to remain blocked with zero attempts, reviews, or artifacts. Exact replay converges across database connections; competing reservations, policy drift, changed ledger parentage, or stored evidence tampering fail closed. The reservation authorizes only a future trusted preflight. It creates no attempt, invokes no model, and grants no implementation, review, GitHub, publication, rollout, or merge authority.

Migration 32 re-inspects the exact prepared Git worktree immediately before provider submission. Passing evidence requires the worktree root, HEAD, index, tracked files, and untracked files to remain clean at the reserved base. One immediate transaction persists the preflight, creates attempt 1, moves the member run/job to active/running, records the coordinated approval/audit trail, and consumes the reservation's sole worker-call claim. Concurrent callers converge on the same attempt and cannot receive a second claim. Dirty, unreadable, mismatched, or changed parentage records a terminal zero-call block or fails closed; running reads independently verify the attempt ID, number, status, start time, and run/job state. The claim is internal and dormant under current empty coordination allowlists; no HTTP/UI action or worker orchestration is added yet, and GitHub, publication, rollout, and merge remain unauthorized.

Migration 33 consumes a newly claimed member attempt through the existing native Codex implementation, trusted Git evidence, and repository-gate pipeline without recreating its already prepared workspace or rerunning preparation. The reusable execution runner rechecks the trusted root, base HEAD, and clean status immediately before dispatch, stores artifacts under the change-set member lineage, and settles the shared run/job/attempt exactly once. A separate atomic reconciliation marks the reservation terminal and consumes its preparation lease; a restart between ledger completion and reconciliation converges without a second model call. Policy-required automatic review resolves the preserved workspace and evidence from the attempt outcome rather than a legacy directory convention. Concurrent callers, terminal replay, post-preflight tampering, worker/gate failure, and review races remain fail closed. This service is internal; it adds no HTTP/UI action, GitHub mutation, publication, rollout, or merge authority.

Migration 34 adds the all-member barrier before compatibility verification. One principal-scoped, idempotent plan may be admitted only after every scheduled run/job/current attempt has succeeded, every changed member with review enabled has exactly one approved review, and a trusted draft or reviewed-patch artifact digest exists. Compatibility checks bind each declared contract to both participating patch digests. Rollout layers preserve the immutable dependency schedule; rollback reverses both layer and within-layer order. Reads reconstruct the complete expected result from parent contracts, schedule layers, and current trusted ledger artifacts, so a forged JSON/digest pair or later member-evidence drift fails closed. The plan explicitly grants no verification execution, GitHub mutation, publication, rollout, or merge authority.

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
