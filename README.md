# Bobsled

A Node.js [Flue v2](https://flueframework.com) agent team powered by the AI subscriptions you already have:

- **CodexAgent** — OpenAI Codex through a ChatGPT Plus/Pro OAuth subscription.
- **CopilotAgent** — GitHub Copilot through a Copilot OAuth subscription.
- **Bobsled** — a Codex-led coding agent that can delegate independent review to a Copilot subagent.

There are no model API keys and no CLI subprocess bridge. Flue uses Pi's native `openai-codex` and `github-copilot` providers directly.

The first factory slice includes read-only GitHub intake, typed repository and work-item contracts, a schema-constrained triage agent, and an authenticated operator UI. `frostyard/clix` remains the representative code-work repository with GitHub mutation disabled. `frostyard/bobsled` is separately enrolled for policy-controlled issue labels and comments only; worker execution and code publication remain disabled there. `frostyard/frostyard-org` is the first full acceptance target: bounded implementation, automatic adversarial review, repository CI, and draft-only publication are enabled, while merge and deployment remain human-controlled outside Bobsled.

M2 adds a durable, separately migratable job ledger, Flue-native verified/deduplicated webhook admission, full Flue observation retention, and a GitHub App operator identity boundary. Triaged work can be admitted, inspected, cancelled, superseded, or human-overridden from the UI. Model blocks remain advisory; bounded issue labels/comments require explicit repository policy and a durable idempotent outbox, while event-driven dispatch remains disabled.

M3 adds explicit `Go fix this` authorization, disposable implementation worktrees, repository preparation/gates, and durable draft evidence. M4-A adds fresh-context Copilot review, at most one Codex remediation round, gate reruns, and a final independent verdict. M4-B adds exact-patch-bound, draft-only publication and required-check tracking in trusted code. Publication remains capability-blocked for clix; the website acceptance target may publish only generated, non-force draft branches after approval.

M6 begins with a versioned multi-repository change-set contract. It records repository-scoped objectives, dependency and compatibility edges, and deterministic dependency-first layers. Every participating repository pair must mutually opt in through enrollment policy. Migrations 26–28 bind immutable member lineage, authorize the complete member set, and snapshot a dependency schedule. Migration 29 can reserve one expiring, dependency-ready member preparation lease at a time. Migration 30 consumes that authority exactly once to create a detached member worktree, run the snapshotted preparation command, and persist clean-workspace or bounded failure evidence. Migration 31 binds that passing evidence and unchanged current policy into a one-use execution-preflight reservation while leaving the blocked ledger parent untouched. Migration 32 re-inspects that exact worktree and atomically creates one running ledger attempt plus a consumed one-call claim, or records a terminal zero-call block. Migration 33 immediately consumes that claim through the native Codex implementation worker, shared trusted Git/gate evidence, terminal reservation settlement, and policy-required adversarial review. Migration 34 requires trusted terminal evidence for every scheduled member before it records patch-digest-bound compatibility checks and deterministic rollout/rollback layers. Migration 35 separately authorizes only non-mutating, network-denied compatibility gates declared by the dependent repositories and bound to both reviewed patch digests. Migration 36 authenticates the retained member workspaces and patch artifacts, exposes a digest-bound peer manifest, and runs each gate once with all peer workspaces bind-mounted read-only inside a fresh Linux network namespace. Migration 37 admits linked publication only after that execution succeeds and every member still has a non-empty approved patch plus current bounded draft-publication policy; it binds those exact reviews, patches, workspaces, policy snapshots, and rollout/rollback layers while granting no branch, GitHub, rollout, or merge authority. Migration 38 revalidates every member through the existing exact-patch publication outbox before claiming a one-use dependency-ordered rollout, creates only non-force draft branches and pull requests, stops on the first failure, and preserves immutable success, blocked, failed, or partial evidence. Migration 39 turns an incomplete rollout into an immutable recovery plan: retained drafts, retry candidates, pending descendants, ambiguous/external progress, dependency-first retry order, reverse human rollback order, and the requirement for a new change set when superseding. Migration 40 consumes an unchanged retry plan once through the existing publication outbox, or records an immutable human rollback/supersession decision. No recovery path grants merge, close, revert, or deployment authority.

M7 begins with a durable conversational-intake envelope. Migration 41 stores one explicitly selected enrolled repository, a bounded manual or GitHub-issue seed, a live schema-validated brief, and an immutable sequence of principal-owned operator/assistant turns. Migration 42 adds an atomic one-use revision claim: reserving a revision appends the operator turn, one native Codex call may return only a schema-valid brief and response, and settlement appends immutable assistant evidence. Migration 43 freezes the operator-confirmed brief, its exact ordered source-turn manifest, and canonical digests as one immutable snapshot. Migration 44 adds one fresh-context Codex triage call bound to that exact snapshot and an immutable repository-policy copy. Migration 45 derives one ledger work item from the original seed plus finalized brief and admits it only with the exact successful triage and unchanged repository-policy snapshot. Migration 46 starts corrections as new principal-owned conversations initialized from the authenticated frozen brief; the source snapshot remains immutable, cancelled correction attempts may be replaced, and admission/correction interlocks prevent competing truth. Creation, revision submission, finalization, correction, triage submission, and run admission are idempotent; turn updates use optimistic concurrency; repository identity cannot drift; and cancellation or finalization is terminal. The intake and triage agents have no sandbox or repository tools and grant no execution, GitHub mutation, or repository research authority.

Authenticated operators can start or resume conversational intake from either a manual task or an enrolled GitHub issue. The UI renders the immutable turn history beside the current structured brief and exposes explicit revise, finalize, superseding-correction, independent-triage, run-admission, and cancel actions. Reads show durable in-flight or failed model state; refreshing the page does not dispatch a call or admit work. Admission is a separate explicit action after triage and still does not authorize execution.

M8 begins by moving repository enrollment out of runtime source configuration. Migration 47 imports the three reviewed declarations once into a durable, versioned SQLite registry with append-only actor/reason evidence, optimistic concurrency, idempotency, immutable GitHub repository identity, and digest-verified policy reads. The Access surface performs a separate bounded metadata-only drift check against each durable record. GitHub discovery and authenticated enrollment/disable actions remain the next boundary; the observation route cannot mutate policy or create work.

See [ROADMAP.md](./ROADMAP.md) for durable milestone status and [docs/architecture.md](./docs/architecture.md) for the control-plane design, including multi-repository change sets.

## Requirements

- Node.js 22.19 or newer
- An eligible ChatGPT subscription for Codex
- A GitHub Copilot subscription

## Setup

```sh
npm install
npm run auth:codex
npm run auth:copilot
npm run auth:status
```

Run those commands from this directory. The local-runtime launcher stores Pi OAuth credentials outside the repository in the platform user-configuration directory and enforces the same protected path for refreshes. Credentials must never be committed, copied between hosts, or shared.

On Linux and macOS the default local paths follow XDG conventions (falling back to `~/.config/bobsled` and `~/.local/share/bobsled`). The launcher loads `~/.config/bobsled/runtime.env` when it exists; set `BOBSLED_ENV_FILE`, `BOBSLED_AUTH_FILE`, `BOBSLED_DATA_DIR`, or `BOBSLED_WORKSPACE_DIR` to override these defaults. Copy `.env.example` to that external protected environment file rather than creating a live `.env` inside the repository. Do not put unrelated provider API keys in it: local workers must not inherit credentials they do not need.

## Run an agent from the CLI

The scripts pass any additional arguments through to `flue run`:

```sh
npm run agent:bobsled -- --message "Inspect this project and suggest the next improvement."
npm run agent:codex -- --message "Explain the provider integration."
npm run agent:copilot -- --message "Review the current TypeScript."
```

Use `--id` to continue a durable conversation:

```sh
npm run agent:bobsled -- --id demo --message "Inspect the project."
npm run agent:bobsled -- --id demo --message "Now implement your top suggestion."
```

## Run the HTTP server

```sh
npm run dev
```

Open <http://127.0.0.1:5173/> for the operator interface. It has five screens:

- **Board** — every run, in six lanes: Ready, Working, Checking, Shipping, Needs you, Done. Each lane says what it means; a card shows only the next valid action. Runs live at `/runs/:id`, and a run that is Working or Checking can be watched live at `/runs/:id/live`.
- **Intake** — pick a task, talk it through, lock it in, queue it up. Locking freezes the brief and sends it straight to an independent check; you read the verdict before anything is queued.
- **Change sets** — work that spans repositories. The machinery exists; nothing has used it yet.
- **Access** — what the GitHub App can reach, and whether that is more than it should be.
- **Activity** — what has happened, newest first.

Every durable decision goes through an authorization sheet that states what it allows, what it still cannot do, and records the reason you give. Nothing in the interface can push, merge, or deploy.

Routes:

- `POST /agents/bobsled/:conversationId`
- `POST /agents/codex/:conversationId`
- `POST /agents/copilot/:conversationId`
- `GET /api/repositories`
- `GET /api/repositories/:owner/:repository/issues`
- `POST /api/triage`
- `GET /api/runs`
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/activity` (read-only live agent steps; starts nothing and spends no subscription call)
- `POST /api/runs`
- `POST /api/runs/:runId/override`
- `POST /api/runs/:runId/cancel`
- `POST /api/runs/:runId/execute` (explicit local-only `Go fix this` authorization)
- `POST /api/runs/:runId/review` (recovery surface; eligible changed runs enter review automatically)
- `GET/POST /api/publications`
- `POST /api/publications/:publicationId/execute` (policy- and App-gated draft-only publication)
- `POST /api/publications/:publicationId/refresh-checks` (reconciles exact PR lifecycle before required checks; retained route name)
- `POST /api/publication-recoveries/replays` (zero-model exact-patch replay and current gates)
- `POST /api/publication-recoveries/replays/:rebaseId/execute` (resume an admitted zero-model replay)
- `POST /api/publication-recoveries/replays/:rebaseId/reviews` (one fresh read-only adversarial review)
- `POST /api/publication-recoveries/reviews/:reviewId/execute` (resume an admitted pre-dispatch review)
- `POST /api/publication-recoveries/reviews/:reviewId/promote` (new immutable draft-publication intent)
- `POST /api/publication-recoveries/resolutions` (immutable zero-call supersession by a later merged publication)
- `GET /api/github-app/status`
- `POST /channels/github/webhook` (the `@flue/github` channel; unavailable until its protected secret is configured)
- `GET/POST /api/github-actions` and `GET /api/github-actions/:actionId`
- `POST /api/github-actions/:actionId/execute` (policy-gated; clix remains blocked)
- `GET /api/operator-auth/status`
- `GET /auth/github/login` and `GET /auth/github/callback` (active only in configured GitHub mode)
- `POST /auth/logout`
- `GET /api/observability/status` (aggregate metadata only)
- `GET /health`

Example:

```sh
curl -X POST http://localhost:5173/agents/bobsled/demo \
  -H 'content-type: application/json' \
  -d '{"kind":"user","body":"Summarize this repository."}'
```

The development server is intended for trusted local use. These coding agents have Flue's `local()` sandbox, which deliberately grants access to the host workspace and shell. Add authentication and a real isolation boundary before exposing the server to other users or a network.

The triage agent is not mounted as a public agent route. It has no sandbox and emits its final decision through a Valibot-validated Flue data writer. The application dispatches it only after resolving the repository from the enrolled registry.

## Model selection

Defaults:

- Codex: `gpt-5.6-sol`
- Copilot: `claude-sonnet-4.6`
- Triage: `gpt-5.6-terra` through the Codex subscription
- Implementation worker: Codex model, defaulting to `BOBSLED_CODEX_MODEL`

Override these in the protected external environment file selected by `BOBSLED_ENV_FILE`:

```dotenv
BOBSLED_CODEX_MODEL=gpt-5.6-terra
BOBSLED_COPILOT_MODEL=gpt-5.4
BOBSLED_TRIAGE_MODEL=gpt-5.6-terra
BOBSLED_WORKER_MODEL=gpt-5.6-sol
```

You can also point at a different Pi credential file:

```dotenv
BOBSLED_AUTH_FILE=/absolute/path/to/auth.json
```

## Verification

```sh
npm test
npm run check:types
npm run build
```

A live smoke test consumes subscription quota and requires completed OAuth setup:

```sh
npm run agent:bobsled -- --message "Reply with exactly: WITNESS ME"
```

## Design notes

`src/providers.ts` adapts Pi's file-based OAuth login to Flue's in-memory provider registry. Credential refreshes and project login merges use one cross-process lock around the complete read-modify-write transaction, then replace the external credential file atomically with mode `0600`. Tokens are never exposed to the agents' sandbox environment.

Flue conversations persist beneath `BOBSLED_DATA_DIR`. Provider credentials remain separate beneath the protected user-configuration directory unless `BOBSLED_AUTH_FILE` explicitly selects another external path.

Bobsled's factory ledger, verified webhook inputs, and Flue observations persist in `bobsled.db` beneath `BOBSLED_DATA_DIR`. Treat that database as sensitive. See [docs/github-app.md](./docs/github-app.md) for the staged GitHub permission plan and [docs/observability.md](./docs/observability.md) for telemetry retention. Configuration/status responses expose booleans and aggregates only; credential values and raw telemetry never reach browser responses or agents.

M3 attempt workspaces and evidence live outside immutable releases under `BOBSLED_WORKSPACE_DIR`. Each repository declares a trusted preparation command separately from its post-change gates; clix uses `mise install`, with mise supplied as a project runtime dependency. Preparation failures are recorded before any model call. Repositories also select a typed worker-network mode: `none` or credential-free `public_dependencies`. clix permits the latter for dependency maintenance. The worker still receives no GitHub credentials or SSH agent, and trusted code—not the model—computes the diff, checks protected paths and size limits, runs required gates, and settles the attempt.

Workers classify results as `changed`, `no_change`, or `blocked`. Trusted evidence rejects disposition/diff mismatches. A verified no-change result with all required gates passing succeeds without inventing a patch and exposes no review or publication action.

M4-A review records live beside the preserved implementation evidence. Copilot receives a bounded evidence bundle without a sandbox; it cannot alter the patch under review. A changes-requested verdict may dispatch one Codex remediation round. Trusted code then recomputes the patch, reruns clix's required `docs` and `verify` gates, and sends passing remediation to a new Copilot conversation for a final verdict. Review approval still grants no publication capability.

M4-B publication is a separate durable outbox. Admission recomputes the preserved patch and binds its digest, approved review, base commit, generated branch, draft-only PR body marker, and required checks. Execution re-verifies those bytes before any token mint, uses repository-scoped Git Data and pull-request permissions, never force-pushes, and reconciles retries only against the exact deterministic commit. Separate read profiles reconcile the exact pull-request lifecycle and required checks; merged or closed PRs become durable History state, while reopened PRs return to their current check state. Bobsled has no merge operation. clix's publication policy remains disabled, while `frostyard/frostyard-org` requires the Cloudflare Workers build before handoff.

Stale-base recovery is a separate immutable evidence path. It can reapply an already approved patch to a verified descendant of its old base, run current preparation and quality gates, and retain exact conflict or drift evidence with zero model calls. A separate one-call read-only Copilot review revalidates that replay in fresh repository context. Only its approval can create a new immutable draft-publication attempt linked to both the replay review and the original blocked publication; the old records are never rewritten. Authenticated, idempotent board actions expose each transition separately; merely loading the board never executes replay, review, promotion, or publication.

If a later human-merged publication already delivered the same repository/task title and the retained replay proves an exact patch conflict, an operator may instead record an immutable `superseded_by_merged_publication` resolution. That decision makes zero model calls and no GitHub mutation, preserves every old row, and moves the obsolete card to History with a link to the merged pull request.

`@flue/github` owns webhook content-type checks, exact-byte HMAC verification, native GitHub event typing, ping acknowledgement, and the conventional channel route. Bobsled's trusted wrapper retains the bounded exact body and durably claims the verified delivery before any later dispatch. The channel does not receive a global outbound token and currently dispatches no agent.

The canonical production target is Linux. See [docs/linux-deployment.md](./docs/linux-deployment.md) for a generic unprivileged-container and systemd deployment contract. Public ingress is a separate, deliberate capability requiring authenticated operator access and verified GitHub webhooks.
