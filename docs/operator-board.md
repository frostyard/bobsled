# Operator board lane criteria

Bobsled's factory board is a read-only projection of durable control-plane state. Moving a card is an outcome of a typed ledger, review, or publication transition; operators cannot drag cards between lanes.

Only admitted runs appear on the board. An issue or manual task that has not completed triage and admission is still intake, not `ready`.

## Evaluation precedence

The server evaluates the latest durable state in this order so a later or more urgent phase wins:

1. Cancelled or failed run
2. Existing publication and stale-base recovery records
3. Existing review record
4. Linked multi-worker implementation plan
5. Active implementation attempt
6. Pending implementation authorization
7. Pre-execution human gate
8. Verified no-change completion
9. Historical review-recovery case
10. Other blocked implementation

For example, an approved review with a blocked publication belongs in `attention`, not `delivery`, because the publication record is the later state.

## Lanes

Lane ids are the contract and never change. The names below are what the interface shows; `src/control-plane/ui/copy.ts` is the single place they are defined.

### Ready (lane id `ready`)

A card is in `ready` when:

- the work has been admitted into the durable ledger;
- its run status is `pending`;
- no implementation attempt, review, or publication has a later state that takes precedence.

The primary action is **Start work**. That authorization covers one bounded implementation attempt and automatic adversarial review/remediation for any successful changed patch.

### Working (lane id `working`)

A card is in `working` when no publication or review takes precedence and either:

- the run status is `active`; or
- its latest implementation attempt is `queued` or `running`.

This includes repository preparation, the implementation worker, and trusted implementation quality gates. It does not include adversarial review.

A linked multi-worker plan also places the card in `working` while it is planned, waiting, active, or complete-but-awaiting integration. Later review and publication evidence still takes precedence, as do a cancelled or failed parent run.

A stale-base rebuild is also `working` while the zero-model exact-patch replay is pending or running.

Before that replay, Bobsled may refresh a missing default-branch commit into a private Git ref. It never advances the trusted checkout's branch: a dirty checkout, unexpected GitHub origin, failed non-interactive fetch, changed HEAD, or commit mismatch stops the rebuild before preparation or model spend.

### Checking (lane id `review`)

A card is in `review` when there is no publication record and its latest adversarial review is `queued` or `running`.

The lane covers the initial independent review, the single policy-permitted remediation round, trusted post-remediation gates, and any fresh final review. These steps are automatic, so the card normally has no mutation action; the run page exposes progress and evidence, and **Watch it work** streams it live.

A validated stale-base rebuild enters `review` with **Review it again**. Once authorized, its one fresh Copilot review remains in this lane until it settles; a model-bearing result cannot be retried.

### Shipping (lane id `delivery`)

A card is in `delivery` when either:

- its latest review is `approved` and no publication record exists yet; or
- its publication is `pending`, `running`, `published`, `checks_pending`, or `ready_for_human`.

Depending on the exact phase, the card may offer **Prepare draft PR**, **Open it on GitHub**, **Check again**, or **Open the draft PR**. **Check again** first verifies the recorded pull request's immutable number, URL, branch, commit, base, and Bobsled marker, then reconciles its open/closed/merged lifecycle and required checks. `ready_for_human` means Bobsled's required checks passed; Bobsled still cannot merge.

An approved stale-base review enters `delivery` with **Prepare draft PR**. That action creates a new immutable pending publication linked to the original blocked publication; **Open it on GitHub** remains a separate explicit action.

### Needs you (lane id `attention`)

A card is in `attention` when a human decision or recovery path is required. Qualifying states are:

- run status `failed`;
- publication `blocked`, `failed`, or `checks_failed`;
- a stale-base publication awaiting **Rebuild on latest main**, or a rebuild/review that stopped with retained evidence;
- review `blocked` or `failed`;
- pre-execution policy block with no implementation attempt (awaiting human approval);
- a successful historical patch with no review record (review recovery);
- any other blocked implementation attempt.
- a linked multi-worker plan whose dependency chain, attempt allowance, provider-call allowance, or wall-clock budget is terminally exhausted.

The card exposes only a valid recovery action. A permanent policy block links to the run page instead of a retry button that would repeat known-futile work.

### Done (lane id `history`)

A publication enters `history` after GitHub reports that its exact recorded pull request was merged or closed without merge. A merged record is terminal and exposes only **Open the PR**. A closed-without-merge record retains **Check again**, because GitHub permits reopening; if reopened, its latest check state places it back in `delivery` or `attention`.

A side-effect-free stale publication may also enter `history` through an immutable **Already shipped another way** decision after its zero-model replay retains an exact patch conflict and a later merged publication matches the repository and task title. The old publication and replay stay unchanged; the resolution performs no model call or GitHub mutation and links the later merged pull request.

## Multi-worker evidence

When a run has an immutable multi-worker plan, its card and run page show:

- active workers and completed tasks;
- workspace attempts used versus the snapshotted maximum;
- active concurrency versus the snapshotted maximum;
- Codex and Copilot calls used versus their separate allowances;
- the absolute plan deadline;
- each task's queued, ready, preparing, running, retryable, succeeded, or blocked state; and
- durable terminal reasons, including transitive dependency failure and budget exhaustion.

This is a read-only projection. Loading or refreshing the board never invokes the scheduler, creates a workspace, reserves capacity, consumes a subscription call, or grants retry authority.

### Done, continued

A card is also placed in collapsed `history` when:

- the run was cancelled; or
- trusted evidence settled it as `no_change`/zero changed files.

Cancelled work may be superseded. Verified no-change work is terminal: it has no patch to review or publish.

## Card movement

The browser periodically reloads the typed board projection while any implementation, review, publication, or check is active. Search and repository filters change visibility only; they never change lane membership or workflow state.

The implementation of these predicates is `src/control-plane/operator-board-view.ts`. Its output is schema-validated before the browser receives it.

## Where the interface lives

`src/control-plane/ui/` renders the whole operator interface as one document:

- `copy.ts` — every display string that is not produced by this projection: lane names and definitions, the two columns of each authorization sheet, brief field labels. Lane ids never change; only these names do.
- `theme.ts` — design tokens and component styles. Type is split by role: sans for the interface, mono only for values that are exact (digests, SHAs, run ids, paths, gate names). The lane colours are the status palette, used everywhere state is shown; the accent means "primary action" and nothing else.
- `client/` — one module per screen, plus the shared runtime in `core.ts` (data access, navigation, toasts, and the authorization sheet).

`test/ui-client.test.ts` boots that script against a small DOM and asserts the board renders, empty lanes explain themselves, and no durable action fires before its authorization is confirmed.

Authorization reasons are optional operator notes, not prose gates. The client supplies an explicit action-specific default when the field is empty; any non-empty bounded note, including a concise approval such as `LGTM`, is retained verbatim. The control plane rejects only empty direct-API reasons and reasons above the existing maximum length.

## Watching a run

A card in `working` or `review` offers **Watch it work**, which opens `/runs/:id/live`. That screen streams the Flue observations already recorded for the run's own implementation, review, and remediation workers, read through `GET /api/runs/:runId/activity`.

Bobsled correlates those observations through the deterministic Flue context id it assigned to the worker. Flue's provider-generated conversation id is retained as evidence but is not used as the authorization boundary for a run's live stream.

It is read-only by design. One attempt, one review, one remediation round, and a patch digest binding an approval to exact bytes all assume nobody reached into a running attempt. There is no way to steer an agent mid-run and there should not be one; the only control on the screen is **Stop**, and changing the outcome means stopping and rewriting the task.
