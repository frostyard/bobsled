# Operator board lane criteria

Bobsled's factory board is a read-only projection of durable control-plane state. Moving a card is an outcome of a typed ledger, review, or publication transition; operators cannot drag cards between lanes.

Only admitted runs appear on the board. An issue or manual task that has not completed triage and admission is still intake, not `Ready`.

## Evaluation precedence

The server evaluates the latest durable state in this order so a later or more urgent phase wins:

1. Cancelled or failed run
2. Existing publication record
3. Existing review record
4. Active implementation attempt
5. Pending implementation authorization
6. Pre-execution human gate
7. Verified no-change completion
8. Historical review-recovery case
9. Other blocked implementation

For example, an approved review with a blocked publication belongs in `Attention`, not `Delivery`, because the publication record is the later state.

## Lanes

### Ready

A card is `Ready` when:

- the work has been admitted into the durable ledger;
- its run status is `pending`;
- no implementation attempt, review, or publication has a later state that takes precedence.

The primary action is **Go fix this**. That authorization covers one bounded implementation attempt and automatic adversarial review/remediation for any successful changed patch.

### Working

A card is `Working` when no publication or review takes precedence and either:

- the run status is `active`; or
- its latest implementation attempt is `queued` or `running`.

This includes repository preparation, the implementation worker, and trusted implementation quality gates. It does not include adversarial review.

### Review

A card is `Review` when there is no publication record and its latest adversarial review is `queued` or `running`.

The lane covers the initial independent review, the single policy-permitted remediation round, trusted post-remediation gates, and any fresh final review. These steps are automatic, so the card normally has no mutation action; **Details** exposes progress and evidence.

### Delivery

A card is `Delivery` when either:

- its latest review is `approved` and no publication record exists yet; or
- its publication is `pending`, `running`, `published`, `checks_pending`, or `ready_for_human`.

Depending on the exact phase, the card may offer **Prepare draft PR**, **Publish draft PR**, **Refresh checks**, or **Open draft PR**. `ready_for_human` means Bobsled's required checks passed; Bobsled still cannot merge.

### Attention

A card is `Attention` when a human decision or recovery path is required. Qualifying states are:

- run status `failed`;
- publication `blocked`, `failed`, or `checks_failed`;
- review `blocked` or `failed`;
- pre-execution policy block with no implementation attempt (awaiting human approval);
- a successful historical patch with no review record (review recovery);
- any other blocked implementation attempt.

The card exposes only a valid recovery action. A permanent policy block has **Details** instead of a retry button that would repeat known-futile work.

### History

A card is placed in collapsed `History` when:

- the run was cancelled; or
- trusted evidence settled it as `no_change`/zero changed files.

Cancelled work may be superseded. Verified no-change work is terminal: it has no patch to review or publish.

## Card movement

The browser periodically reloads the typed board projection while any implementation, review, publication, or check is active. Search and repository filters change visibility only; they never change lane membership or workflow state.

The implementation of these predicates is `src/control-plane/operator-board-view.ts`. Its output is schema-validated before the browser receives it.
