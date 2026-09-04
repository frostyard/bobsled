export const actionsSource = String.raw`
/* ---------- board actions ---------- */
// Every one of these writes to an immutable log, so every one of them goes
// through the same sheet: what it allows, what it still cannot do, and a
// reason you actually wrote.

function actionButton(card, action) {
  const button = el('button', {
    class: 'btn' + (action.emphasis === 'primary' ? ' primary' : action.emphasis === 'danger' ? ' danger' : ''),
    text: action.label,
  });
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    event.preventDefault();
    button.disabled = true;
    try { await runAction(card, action); }
    finally { button.disabled = false; }
  });
  return button;
}

function subjectOf(card) {
  return card.repositoryId + ' · ' + card.workItemKey + ' · ' + card.title;
}

function boundOf(card) {
  const bound = [];
  const attempt = card.run.jobs[0] && card.run.jobs[0].attempts.slice(-1)[0];
  const base = attempt && attempt.outcome && attempt.outcome.evidence && attempt.outcome.evidence.baseCommit;
  if (base) bound.push(['Starting from', String(base).slice(0, 8)]);
  if (card.metrics.filesChanged !== undefined) bound.push(['The change', card.metrics.filesChanged + ' files, ' + card.metrics.diffLines + ' lines']);
  if (card.publication && card.publication.pullNumber) bound.push(['Pull request', '#' + card.publication.pullNumber]);
  return bound;
}

async function runAction(card, action) {
  const run = card.run;
  const job = run.jobs[0];

  if (action.kind === 'open_pull_request' && action.url) {
    window.open(action.url, '_blank', 'noopener,noreferrer');
    return;
  }
  if (action.kind === 'revise_task') {
    navigate('/runs/' + card.id + '?rewrite=1');
    return;
  }

  const decision = await authorize(action.kind, { subject: subjectOf(card), bound: boundOf(card) });
  if (!decision.ok) return;
  const reason = decision.reason;

  try {
    if (action.kind === 'go_fix') {
      const busy = toast('Starting work…', { tone: 'busy', detail: 'Preparing a copy of the repo. This runs for a few minutes.' });
      try {
        await post('/api/runs/' + run.id + '/execute', { reason, expectedVersion: run.version }, false);
        toast('Work finished.', { detail: 'Open the run to see what the review said.', action: 'Open run', href: '/runs/' + card.id });
      } finally { busy.remove(); }
    } else if (action.kind === 'human_override') {
      await post('/api/runs/' + run.id + '/override', { reason, expectedVersion: run.version }, false);
      toast('Approved.', { detail: 'It is in Ready. Starting it is still up to you.' });
    } else if (action.kind === 'cancel') {
      await post('/api/runs/' + run.id + '/cancel', { reason, expectedVersion: run.version }, false);
      toast('Dropped.', { detail: 'Everything it produced is kept.' });
    } else if (action.kind === 'supersede') {
      const admitted = await post('/api/runs', { repositoryId: card.repositoryId, workItem: job.workItemSnapshot, triageDecision: job.triageDecision, supersedesRunId: run.id });
      toast('Queued a new run.', { detail: 'It is waiting in Ready.', action: 'Open it', href: '/runs/' + admitted.id });
    } else if (action.kind === 'manual_review') {
      const busy = toast('Reviewing…', { tone: 'busy', detail: 'A second model is reading the change.' });
      try {
        await post('/api/runs/' + run.id + '/review', { reason, expectedVersion: run.version }, false);
        toast('Review finished.', { action: 'See what it said', href: '/runs/' + card.id });
      } finally { busy.remove(); }
    } else if (action.kind === 'prepare_publication') {
      await post('/api/publications', { runId: run.id, expectedVersion: run.version, reason });
      toast('Draft PR is ready to open.', { detail: 'Nothing has reached GitHub yet.' });
    } else if (action.kind === 'publish_publication') {
      const busy = toast('Opening it on GitHub…', { tone: 'busy' });
      try {
        const done = await post('/api/publications/' + card.publication.id + '/execute', {}, false);
        toast(done.pullNumber ? 'Opened PR #' + done.pullNumber + '.' : 'Published.', { detail: 'Merging is still yours.' });
      } finally { busy.remove(); }
    } else if (action.kind === 'refresh_checks') {
      await post('/api/publications/' + card.publication.id + '/refresh-checks', {}, false);
      toast('Checked with GitHub.');
    } else if (action.kind === 'replay_publication') {
      const recovery = card.publicationRecovery;
      const resuming = recovery && recovery.rebase && recovery.rebase.status === 'pending';
      const busy = toast('Rebuilding on the latest main…', { tone: 'busy', detail: 'No model calls. Same change, current base.' });
      try {
        if (resuming) await post('/api/publication-recoveries/replays/' + recovery.rebase.id + '/execute', { reason });
        else await post('/api/publication-recoveries/replays', { sourcePublicationId: card.publication.id, reason });
        toast('Rebuild finished.', { action: 'Open run', href: '/runs/' + card.id });
      } finally { busy.remove(); }
    } else if (action.kind === 'review_publication_replay') {
      const recovery = card.publicationRecovery;
      if (!recovery || !recovery.rebase) throw new Error('The board is out of date. Refresh and try again.');
      const resuming = recovery.review && recovery.review.status === 'pending';
      const busy = toast('Reviewing the rebuild…', { tone: 'busy', detail: 'One call, no retries.' });
      try {
        if (resuming) await post('/api/publication-recoveries/reviews/' + recovery.review.id + '/execute', { reason });
        else await post('/api/publication-recoveries/replays/' + recovery.rebase.id + '/reviews', { reason });
        toast('Review finished.', { action: 'See what it said', href: '/runs/' + card.id });
      } finally { busy.remove(); }
    } else if (action.kind === 'promote_publication_replay') {
      const recovery = card.publicationRecovery;
      if (!recovery || !recovery.review) throw new Error('The board is out of date. Refresh and try again.');
      await post('/api/publication-recoveries/reviews/' + recovery.review.id + '/promote', { reason });
      toast('Draft PR is ready to open.');
    } else if (action.kind === 'resolve_publication_supersession') {
      const recovery = card.publicationRecovery;
      if (!recovery || !recovery.supersedingCandidate) throw new Error('The board is out of date. Refresh and try again.');
      await post('/api/publication-recoveries/resolutions', {
        sourcePublicationId: card.publication.id,
        supersedingPublicationId: recovery.supersedingCandidate.publicationId,
        reason,
      });
      toast('Marked as already shipped.', { detail: 'Both pull requests are unchanged.' });
    }
    await loadBoard(false);
    if (location.pathname.startsWith('/runs/')) render();
  } catch (error) {
    fail(error);
  }
}
`;
