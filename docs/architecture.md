# Bobsled Factory Architecture

## Control-plane boundary

Bobsled separates trusted orchestration from model-directed execution.

The trusted control plane owns repository enrollment, credentials, policy, job identity, approvals, durable state, GitHub mutations, and publication. Agents receive normalized work and repository context through validated schemas. A model cannot choose an unenrolled repository, weaken a gate, grant itself a capability, or publish work directly.

## Schema boundaries

- **Repository contract** — enrolled identity, default branch, agent instruction surfaces, quality gates, protected paths, and allowed capabilities.
- **Work intake** — normalized GitHub issue or operator-authored task.
- **Triage decision** — route, risk, confidence, rationale, acceptance criteria, missing information, and allowed label suggestions.
- **Work plan** — one bounded M3 implementation task; later milestones add dependency-aware worker DAGs.
- **Preparation and gate results** — bounded trusted commands with exit status, duration, output, timeout, and evidence.
- **Publication request** — later milestone: trusted, policy-checked branch and draft-PR request.

Schemas validate both the TypeScript boundary and runtime data. Model decisions are data for trusted policy code, never authorization by themselves.

## M1 request flow

1. The UI requests repositories from the static enrollment registry.
2. The read-only GitHub adapter fetches metadata and open issues for an enrolled repository.
3. The operator selects an issue or enters a local task.
4. The server validates the intake and binds the enrolled repository contract.
5. The Flue triage agent receives immutable initial data, produces one `TriageDecision`, and emits it through a schema-validated data writer.
6. The server validates the returned decision again and displays it. Nothing is written to GitHub.

## Future multi-repository model

A multi-repository request becomes one `ChangeSet` containing a dependency graph and one repository-scoped `Job` per target. Each job retains its own policy, workspace, gates, review, branch, and PR. The coordinator may order or block jobs but may not collapse their evidence or claim atomicity GitHub cannot provide.

Cross-repository publication is a barrier, not a distributed transaction: Bobsled holds draft publication until all jobs are publishable, then creates linked draft PRs and exposes partial failures explicitly.

## M5 multi-worker planning

The first M5 contract represents one repository-scoped plan as a versioned, schema-validated dependency DAG. Every task has a stable lowercase ID, bounded objective, acceptance criteria, and explicit in-plan dependencies. Trusted validation rejects duplicate IDs and edges, missing dependency targets, self-dependencies, and cycles. A deterministic helper derives dependency-readiness layers in declared task order. Version 1 plans remain readable as dependency-only historical input.

Version 2 assigns each task one or more literal repository-relative ownership scopes. A scope owns one exact file, one directory subtree, or the entire repository; glob syntax, absolute paths, empty/dot/parent segments, backslashes, and control characters are rejected. Redundant scopes inside one task are invalid. Two tasks may overlap only when a transitive dependency orders them, so tasks that could become ready independently cannot claim the same path even when a static topological layering happens to place them in different layers.

Trusted Git changed paths are bound to a version 2 task through `authorizeTaskPatch`. The boundary validates the complete plan and task identity before applying exact-file, directory-subtree, or repository ownership. Invalid, duplicate, and outside-scope paths produce typed deterministic violations; an unknown task or more than 100 changed paths fails closed. The low-level matcher is private so callers cannot bypass plan and path validation.

`planIntegrationAssembly` prepares the trusted input for a later integration workspace. For one dependency-bearing task it discovers the complete transitive prerequisite set, recomputes every task's patch-scope authorization, requires every patch to share the requested base commit, and orders the resulting stack topologically in declared task order. Missing, duplicate, unrelated, base-mismatched, or out-of-scope evidence blocks the plan and exposes no partial assembly stack.

The integration workspace service accepts only a ready plan and its exact ordered patch payloads. It verifies task identity, SHA-256 digests, per-patch and aggregate byte limits, canonical base commit, and a fresh UUID-addressed destination before creating a detached Git worktree. Patches are applied through `git apply --index` without a shell. A rejected patch preserves the preceding stack and records bounded conflict evidence; a successful stack must leave HEAD unchanged and its Git-computed changed paths must equal the trusted plan. Verified empty patches remain explicit no-change prerequisites. The combined patch digest and result are stored beside the isolated workspace.

Scope compatibility, patch authorization, integration readiness, and workspace assembly do not authorize a model call. Every projection reports `executionAuthorized: false` or `workerAuthorized: false`; these slices add no worker fan-out, conflict resolution, retry, token spend, concurrent execution, or GitHub capability. A later M5 step may give a bounded integration worker only the assembled workspace and typed task context.

The bounded integration-worker contract declares a one-call budget for a known dependency-bearing task, and each runner invocation makes one native Pi/Codex dispatch. The staged index is the immutable prerequisite baseline; the worker is instructed to inspect it but leave all additional edits unstaged. It receives the assembled workspace, selected version 2 task and plan, repository policy, work item, scrubbed environment, and no GitHub credential. Trusted postcondition evaluation requires unchanged HEAD and staged-patch digest, recomputes the worker's unstaged paths against task ownership, compares model claims with Git evidence, and checks disposition/final-digest consistency. Any violation blocks the result and `furtherWorkerAuthorized` is always false.

This contract and runner are not yet connected to job orchestration or the operator UI. Required repository gates, durable ledger evidence, durable prevention of a repeated invocation, clean-stack execution, and a separate conflict-resolution path must exist before the roadmap's integration-worker item is complete.

The first durable orchestration boundary reserves an integration invocation by principal, assembly UUID, plan digest, task ID, and idempotency key. A SQLite transaction may move it from `reserved` to `running` exactly once while atomically fixing `workerCalls` at one. Completion accepts only matching typed postcondition evidence; process failure is terminal historical evidence. Replays of the same reservation converge, while changed idempotency input, assembly reuse, concurrent claims, cross-principal access, and any attempt to reclaim terminal history fail closed. Recovery requires a new assembly and invocation rather than erasing or retrying the prior call.

An immutable M5 plan parent now binds a validated version 2 plan, its canonical SHA-256 digest, and base commit to an existing principal-owned job. An assembly parent binds one dependency-bearing task and its complete typed workspace result to that plan. Exact plan and assembly replays converge after process interruption; changed idempotency input, duplicate plan evidence, task/base mismatches, competing assemblies, or cross-principal access fail closed. Invocation reservation now verifies this complete chain and accepts only an `assembled` parent whose owner, plan digest, and task match.

Migration 4 establishes `job → multi-worker plan → integration assembly → one-use invocation` as the durable evidence lineage. Trusted gate results can now attach to the invocation without becoming orphaned; executing and persisting those gates is the next bounded M5 slice.

## M2 durable ledger

Bobsled workflow state lives in `bobsled.db` beneath `BOBSLED_DATA_DIR`, separate from Flue's conversation database. This avoids coupling product migrations to framework persistence and leaves either side replaceable.

Admission creates a `Run` and repository-scoped `Job` in one transaction. It snapshots the work item, repository contract, and optional triage decision. Supporting tables reserve stable identities for attempts, artifacts, approvals, and append-only audit events.

The ledger uses three forms of protection without creating dead ends:

- Idempotency keys replay the same admission safely and reject reuse with different input.
- Optimistic versions prevent stale browser actions from overwriting newer state.
- Ownership is supplied by the trusted server boundary rather than accepted from browser input.

A non-ready triage decision starts blocked. A human may override it with a reason. Cancellation is terminal for that historical run, but a new run may explicitly supersede cancelled or failed work. This preserves evidence while keeping recovery cheap.

Policy snapshots are immutable historical evidence. New schema fields may be optional when reading old rows, but new authority is never backfilled: an older snapshot must be superseded by a newly admitted run before it can use a later execution capability.

## M3 local execution

`Go fix this` is an explicit authenticated transition from a pending run to one attempt. Trusted code resolves the enrolled source checkout and base commit, creates a detached Git worktree, and assigns a private sandbox home. The Flue implementation worker uses the native Pi-backed Codex provider with `local({ cwd })`; the surrounding locked Linux service/container is the host isolation boundary, while the worktree supplies attempt separation. This is not described as a multi-tenant security sandbox.

Before the model runs, the repository's snapshotted `workspacePreparation` command executes with bounded time/output and a scrubbed environment. Clix declares `mise install`; Bobsled supplies mise as a project dependency and shares only its credential-free tool cache between attempts. A missing source, missing preparation executable, failed setup, or timeout settles with durable evidence before model token spend.

The worker receives the worktree path, immutable repository/work snapshots, and no GitHub credentials. It must emit a schema-valid one-task plan before editing and a schema-valid result when finished. Its snapshot contains a typed worker-network policy: `none` prohibits network use, while `public_dependencies` permits only credential-free public package/module version discovery and resolution. clix selects `public_dependencies` so maintenance work can update dependency metadata without granting GitHub tokens, SSH agents, remote mutation, commits, branches, or pushes. Model-reported paths and tests remain advisory; trusted code still computes the patch and enforces every gate and boundary.

Implementation results also declare one typed disposition: `changed`, `no_change`, or `blocked`. Trusted diff evidence must agree with that claim. A zero-file `no_change` result succeeds only when every required gate passes; it is terminal and cannot enter adversarial review or publication because no patch exists. A claimed change without a patch, a no-change claim with a patch, or any worker-reported blocker remains blocked. Historical stored worker evidence is normalized only while reading it, so adding the field does not strand earlier successful patches or weaken the schema required from new workers.

Trusted code then includes untracked files in an intent-to-add diff, computes the patch against the immutable base commit, verifies HEAD did not move, detects protected paths, enforces repository file/diff limits, and runs every required gate from the policy snapshot. Preparation, plan, worker result, gate logs, patch, digest, and summary are stored as attempt artifacts under `BOBSLED_WORKSPACE_DIR`. Any violation blocks the preserved attempt; success still creates no branch, push, PR, or GitHub mutation.

## M4-A adversarial review

One operator `Go fix this` authorization covers bounded implementation and the repository policy's mandatory review/remediation sequence. A successful changed attempt automatically enters a policy-authored review transition; verified no-change and blocked/failed attempts do not spend a reviewer call. The manual review API remains only as an operator recovery surface for historical or interrupted state and is absent from the normal UI flow.

Every fresh Copilot reviewer receives the bounded work item, repository policy, structured implementation evidence, patch, and a separate snapshot of the complete repository at that review round. `read_only_repository` is an invariant, not a weaker/stronger selectable mode. The Flue sandbox path-jails reads to that snapshot and exposes only bounded read, list, and text-search operations: no shell, network, GitHub, credentials, write, edit, or mutation capability. Symlink and parent-path escapes are rejected. Findings and verdicts are schema-validated; model approval is evidence, never publication authority.

When the initial verdict requests changes, repository policy permits at most one fresh Codex remediation round in the existing disposable worktree. Trusted code then recomputes the entire patch from the immutable base, checks HEAD and protected/size boundaries, and reruns every required gate. Gate or policy failure blocks before spending a second reviewer call. A passing remediation receives a new fresh-context Copilot review over a newly captured post-remediation repository snapshot; only its approval settles the review as approved. Repository-context artifacts record the round and denied capability set. Every round and failure remains durable, and an approved attempt cannot be reviewed repeatedly. M4-A still has no branch, push, PR, or GitHub mutation surface.

The operator surface does not reduce this evidence to a status badge. Trusted code projects stored verdicts, findings, remediation, final patch evidence, and gate results into a schema-validated operator view with one status-specific next action. Blocked and failed reviews expand automatically; blocked findings can seed an editable revised task, but a settled attempt cannot spend another review cycle against unchanged evidence. Historical malformed or older outcome shapes degrade to a visible failure/action state rather than disappearing from the UI.

The factory board is also a trusted projection rather than a second browser-owned state machine. Server code combines each run, latest attempt/review, and publication record into a schema-validated `ready`, `working`, `review`, `delivery`, `attention`, or `history` card with only currently valid actions. Cards move automatically; there is no drag-to-change-status surface. The browser renders those projections as responsive lanes and opens raw task, triage, implementation, review, delivery, and audit evidence in a details drawer. Active work polls for new projections while terminal history remains collapsed by default.

Exact lane predicates, precedence, and terminal/recovery cases are documented in `docs/operator-board.md` and summarized directly above the board.

## M4-B controlled publication

Publication begins as a durable idempotent intent over one approved review. Admission resolves the immutable policy snapshot, successful attempt, approved review, review artifact digest, base commit, and preserved workspace. Trusted code recomputes the binary Git diff and rejects missing workspaces, moved HEAD, unreviewed files, unsupported path operations, oversized content, or any byte-level digest mismatch before consulting GitHub policy or minting authority.

Repository policy supplies a generated branch prefix, draft-only invariant, no-force invariant, attempt bound, content bound, and required check names. clix snapshots this contract with publication disabled. Older runs cannot silently gain publication capability, and current repository policy may tighten or revoke authority before execution.

When explicitly enabled, the control plane mints a repository-ID-scoped installation token with only Contents write and Pull requests write. It verifies the remote default branch still equals the approved base, creates content-addressed blobs/tree/commit with deterministic identity and evidence trailers, creates or advances only Bobsled's generated branch without force, and opens only a draft PR. A durable marker reconciles interruption, but recovery succeeds only when the PR head equals the recomputed deterministic commit. A separate Checks-read token polls snapshotted required checks; outcomes stop at `ready_for_human`. There is no merge API, model GitHub tool, arbitrary branch selection, workflow permission, or token-bearing subprocess.

## M2 event admission

The webhook endpoint is an explicitly mounted `@flue/github` channel at `/channels/github/webhook`. Flue enforces JSON-only ingress, verifies GitHub's HMAC over the exact request bytes before parsing, narrows the native payload type from `X-GitHub-Event`, and acknowledges pings without dispatch. Bobsled's bounded capture middleware retains those same bytes only after the channel reports successful verification.

A delivery ID is admitted once; replaying the same bytes is harmless, while reusing the ID with different content is a conflict. Signed input outside the `frostyard` organization is rejected. The channel is intentionally stateless; durability and policy remain application-owned.

The durable delivery row retains the exact verified bytes and a SHA-256 digest. This allows later asynchronous routing without relying on an in-memory request. Recognized event families are accepted for future processing; unknown but valid event names are retained as ignored rather than discarded. Installation payloads append an effective-permission snapshot. Admission does not dispatch an agent or mutate GitHub. Outbound operations do not use the channel blueprint's global token example; they continue through Bobsled's scoped installation broker and typed action outbox.

## Operator identity and GitHub authority

Local private operation keeps the reversible `local_trusted` principal. When `BOBSLED_OPERATOR_AUTH_MODE=github`, incomplete configuration fails protected routes closed. A complete configuration enables a GitHub App web authorization flow with:

- random one-use state and PKCE S256;
- an encrypted, ten-minute server-side verifier record;
- transient user-token exchange followed by `/user` and exact `/user/memberships/orgs/frostyard` checks;
- acceptance only for membership state `active`;
- an opaque HMAC-signed session cookie whose token is stored only as SHA-256;
- eight-hour server-side expiry and explicit revocation on logout;
- `Secure`, `HttpOnly`, `SameSite=Lax`, `__Host-` cookies;
- exact-origin validation for authenticated mutation requests.

GitHub user and refresh tokens are never retained. A session principal is `github:<numeric-user-id>` so mutable logins do not define ownership. Existing runs created in `local_trusted` mode retain their historical owner and remain recoverable by returning to that reversible mode; Bobsled does not silently transfer ownership on first login.

Installation authority is separate from operator identity. Octokit's App authentication strategy mints a short-lived token narrowed to the enrolled repository's immutable GitHub database ID and one typed capability profile. Callers receive only a bounded authenticated request closure, never the token. The closure pins the GitHub API origin, overwrites any caller-supplied authorization header, and expires when its callback returns. The current profiles are issue metadata read/write and repository contents read. No enrolled repository permits a write profile yet.

## Durable GitHub issue actions

Label and comment changes use a typed outbox rather than giving an agent a general GitHub client. Admission and execution are separate authenticated actions. Each row has an owner, idempotency key and request digest, status, bounded execution lease, attempt count, stable evidence, and an explicit policy block or error.

Execution checks current repository policy before asking for installation authority. A read-only repository records blocked intent without minting a token. If policy later changes deliberately, the same row can be executed instead of being discarded or recreated.

Triage labels are a closed vocabulary. Execution adds the desired label idempotently and removes only the other Bobsled route labels, preserving unrelated human labels. A comment receives a stable hidden `bobsled-action` marker. Before posting, retries scan comment history from the last page backward, with a 2,000-comment bound, and recognize a prior successful post by marker. This closes the crash window where GitHub accepted a comment but Bobsled had not yet recorded success. Exceeding the bound produces a human-visible policy block rather than unbounded API or model work.

## Observability store

Bobsled subscribes once per Node process to Flue's global `observe()` stream. It queues only an in-memory pointer on the synchronous emission path and persists batches in a microtask. Each row contains:

- the complete frozen `FlueObservation`, including exporter-only details such as `turn_request`, normalized tool arguments and results, reasoning, usage, and live error stacks;
- an inspectable JSON projection that preserves cycles and non-JSON scalar markers;
- a lossless Node V8 serialization and SHA-256 digest;
- event envelope and correlation columns for process, instance, submission, conversation, session, operation, turn, task, and event type;
- safe request method and URL path metadata.

Flue already omits raw image bytes from observations. Bobsled additionally excludes the event context's environment, request headers, cookies, authorization values, and URL query string. These are execution secrets rather than observability events. The SQLite database is forced to mode `0600`; raw observation content has no HTTP API. `/api/observability/status` and `/health` expose only counts, stored byte totals, process count, latest timestamp, and event-type counts. Retention is indefinite until a versioned retention/export policy is introduced.
