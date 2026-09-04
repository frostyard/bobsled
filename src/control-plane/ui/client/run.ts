export const runSource = String.raw`
/* ---------- stage model ---------- */
// The rail answers "where is this and what is holding it" before any prose is
// read. Each stage reads durable evidence; none of it is inferred from a lane.

function stagesFor(card) {
  const run = card.run;
  const job = run.jobs[0] || {};
  const attempt = (job.attempts || []).slice(-1)[0];
  const review = (job.reviews || []).slice(-1)[0];
  const publication = card.publication;
  const evidence = review && review.operatorView && review.operatorView.evidence;
  const outcome = attempt && attempt.outcome && attempt.outcome.evidence;
  const files = (outcome && outcome.filesChanged) !== undefined ? outcome.filesChanged : (evidence && evidence.filesChanged);
  const lines = (outcome && outcome.diffLines) !== undefined ? outcome.diffLines : (evidence && evidence.diffLines);

  const stages = [];
  stages.push({
    id: 'triage', name: 'Checked',
    state: job.triageDecision ? (run.status === 'blocked' && (job.attempts || []).length === 0 ? 'blocked' : 'done') : 'todo',
    note: job.triageDecision
      ? (job.triageDecision.route === 'ready_for_agent' ? 'clear enough to hand off' : 'flagged for you to look at') + ' · ' + job.triageDecision.risk + ' risk'
      : 'not checked',
  });
  stages.push({
    id: 'implement', name: 'Built',
    state: !attempt ? 'todo'
      : attempt.status === 'running' || attempt.status === 'queued' ? 'active'
      : attempt.status === 'succeeded' ? 'done' : 'blocked',
    note: !attempt ? 'not started'
      : attempt.status === 'queued' ? 'starting up'
      : attempt.status === 'running' ? 'writing code now'
      : files !== undefined ? files + (files === 1 ? ' file, ' : ' files, ') + lines + ' lines'
      : attempt.status,
  });
  stages.push({
    id: 'review', name: 'Second opinion',
    state: !review ? 'todo'
      : review.status === 'queued' || review.status === 'running' ? 'active'
      : review.status === 'approved' ? 'done' : 'blocked',
    note: !review ? 'not started'
      : review.status === 'queued' ? 'starting'
      : review.status === 'running' ? 'reading the change'
      : review.status === 'approved' ? 'nothing blocking'
      : blockingCount(review) + ' blocking',
  });
  stages.push({
    id: 'publish', name: 'Ship',
    state: !publication ? 'todo'
      : ['merged', 'ready_for_human'].includes(publication.status) ? 'done'
      : ['blocked', 'failed', 'checks_failed'].includes(publication.status) ? 'blocked' : 'active',
    note: !publication ? 'not started' : publication.pullNumber ? 'PR #' + publication.pullNumber : publication.status.replace(/_/g, ' '),
  });
  stages.push({
    id: 'merged', name: 'Merged',
    state: publication && publication.status === 'merged' ? 'done' : 'todo',
    note: publication && publication.status === 'merged' ? 'you merged it' : '—',
  });
  return stages;
}

function blockingCount(review) {
  const report = review && review.operatorView && review.operatorView.primaryReport;
  return report ? report.findings.filter((finding) => finding.blocking).length : 0;
}

function defaultStage(stages) {
  const blocked = stages.filter((stage) => stage.state === 'blocked').slice(-1)[0];
  if (blocked) return blocked.id;
  const active = stages.find((stage) => stage.state === 'active');
  if (active) return active.id;
  const done = stages.filter((stage) => stage.state === 'done').slice(-1)[0];
  return done ? done.id : 'triage';
}

/* ---------- run surface ---------- */

async function runSurface(surface, params) {
  const runId = params[0];
  if (!state.cards.length) await loadBoardQuietly();
  let card = state.cards.find((entry) => entry.id === runId);
  if (!card) {
    const board = await json('/api/operator-board');
    state.cards = board.cards;
    card = state.cards.find((entry) => entry.id === runId);
  }
  if (!card) {
    surface.append(el('div', { class: 'center-note' }, [
      el('h2', { text: 'That run is not on the board.' }),
      el('p', { text: 'It may belong to another operator, or the id may be wrong.' }),
      el('button', { class: 'btn primary', text: 'Back to the board', onclick: () => navigate('/') }),
    ]));
    return;
  }

  const stages = stagesFor(card);
  let selected = new URLSearchParams(location.search).get('stage') || defaultStage(stages);

  setTopbar([
    el('div', { class: 'crumbs' }, [
      el('a', { href: '/', 'data-link': true, text: 'Board' }), el('span', { text: ' › ' }),
      el('span', { text: shortRepo(card.repositoryId) }), el('span', { text: ' › ' }),
      el('b', { text: card.title }),
    ]),
    el('div', { class: 'stat spacer', text: card.workItemKey }),
    el('div', { class: 'stat mono', text: card.id.slice(0, 8) }),
    card.lane === 'attention' ? el('div', { class: 'stat alarm', text: card.phase }) : el('div', { class: 'stat', text: card.phase }),
  ]);

  const rail = el('div', { class: 'stagerail', role: 'tablist', 'aria-label': 'Run stages' });
  const detail = el('div', { class: 'detail' });
  surface.append(rail, detail);

  const paint = () => {
    clear(rail);
    for (const stage of stages) {
      const button = el('button', {
        class: 'stage', role: 'tab', 'data-state': stage.state,
        'aria-selected': String(stage.id === selected),
      }, [el('strong', { text: stage.name }), el('span', { text: stage.note })]);
      button.addEventListener('click', () => {
        selected = stage.id;
        history.replaceState({}, '', '/runs/' + card.id + '?stage=' + stage.id);
        paint();
      });
      rail.append(button);
    }
    clear(detail);
    detail.append(stagePane(card, selected), timelinePane(card));
  };
  paint();

  surface.append(actionBar(card));

  if (new URLSearchParams(location.search).get('rewrite')) openRewrite(card);
  return undefined;
}

async function loadBoardQuietly() {
  try { const board = await json('/api/operator-board'); state.cards = board.cards; updateAttention(); } catch { /* the surface will report it */ }
}

/* ---------- stage panes ---------- */

function pane(title, note, body) {
  return el('div', { class: 'col-pane' }, [
    el('div', { class: 'pane-head' }, [el('h2', { text: title }), note ? el('span', { class: 'pane-note', text: note }) : null]),
    el('div', { class: 'pane-body' }, body),
  ]);
}

function list(label, values) {
  if (!values || !values.length) return null;
  return el('div', {}, [
    el('div', { class: 'subhead', text: label }),
    el('ul', { class: 'plainlist' }, values.map((value) => el('li', { text: String(value) }))),
  ]);
}

function stagePane(card, stageId) {
  const job = card.run.jobs[0] || {};
  const attempt = (job.attempts || []).slice(-1)[0];
  const review = (job.reviews || []).slice(-1)[0];

  if (stageId === 'triage') {
    const decision = job.triageDecision;
    if (!decision) return pane('Checked', '', [el('p', { class: 'prose', text: 'This run has no triage decision recorded.' })]);
    return pane('What the check decided', decision.route === 'ready_for_agent' ? 'clear to hand off' : 'flagged for you', [
      el('div', { class: 'verdict', 'data-route': decision.route }, [
        el('div', { class: 'tags' }, [
          el('span', { class: 'tag ' + (decision.route === 'ready_for_agent' ? 'ok' : 'warn'), text: decision.route === 'ready_for_agent' ? 'Clear enough to hand off' : 'You should look first' }),
          el('span', { class: 'tag', text: decision.risk + ' risk' }),
        ]),
        el('h3', { text: decision.summary }),
        el('p', { class: 'prose', text: decision.rationale }),
      ]),
      list('Done when', decision.acceptanceCriteria),
      list('Still missing', decision.missingInformation),
      el('div', {}, [el('div', { class: 'subhead', text: 'The task as written' }), el('p', { class: 'prose', style: 'white-space:pre-wrap', text: (job.workItemSnapshot && job.workItemSnapshot.body) || 'No details given.' })]),
    ]);
  }

  if (stageId === 'implement') {
    if (!attempt) return pane('Built', '', [el('p', { class: 'prose', text: 'Nothing has been built yet. Starting the work is up to you.' })]);
    const worker = attempt.outcome && attempt.outcome.worker && attempt.outcome.worker.result;
    const evidence = attempt.outcome && attempt.outcome.evidence;
    const body = [el('p', { class: 'prose', text: (worker && worker.summary) || ('The attempt is ' + attempt.status + '.') })];
    if (card.multiWorker) {
      const budget = card.multiWorker.budget;
      body.push(el('div', { class: 'subhead', text: 'Split across workers' }));
      body.push(el('p', { class: 'prose', text: card.multiWorker.summary }));
      body.push(evGrid([
        ['Running now', budget.concurrentUsed + ' of ' + budget.concurrentMax],
        ['Attempts', budget.attemptsUsed + ' of ' + budget.attemptsMax],
        ['Codex calls', budget.openaiCodexCallsUsed + ' of ' + budget.openaiCodexCallsMax],
        ['Copilot calls', budget.githubCopilotCallsUsed + ' of ' + budget.githubCopilotCallsMax],
      ]));
      body.push(list('Pieces', card.multiWorker.tasks.map((task) => task.title + ' — ' + task.state + (task.reason ? ' (' + task.reason + ')' : ''))));
      body.push(list('What stopped it', card.multiWorker.reasons));
    }
    if (evidence) body.push(evGrid(patchCells(evidence)));
    if (evidence && evidence.gates) body.push(gateGrid(evidence.gates));
    body.push(list('Files it touched', worker ? worker.changedPaths : evidence && evidence.changedPaths));
    body.push(list('Checks it ran itself', worker && worker.testsRun));
    body.push(list('Notes it left', worker && worker.notes));
    return pane('What it built', 'attempt ' + attempt.number, body.filter(Boolean));
  }

  if (stageId === 'review') {
    if (!review) return pane('Second opinion', '', [el('p', { class: 'prose', text: 'Nothing has been reviewed yet. Reviews start on their own once something is built.' })]);
    const view = review.operatorView;
    if (!view) return pane('Second opinion', review.status, [el('p', { class: 'prose', text: 'The review is ' + review.status + '. No report was recorded.' })]);
    const body = [];
    if (view.error) body.push(el('div', { class: 'inline-error' }, [el('b', { text: 'The review did not finish.' }), el('span', { text: view.error })]));
    const report = view.primaryReport;
    if (report) {
      body.push(el('p', { class: 'prose', text: report.summary }));
      for (const finding of report.findings) {
        body.push(el('div', { class: 'finding-row', 'data-severity': finding.blocking ? 'blocking' : 'minor' }, [
          el('div', { class: 'fid' }, [
            el('b', { text: finding.blocking ? 'Blocking' : 'Minor' }),
            el('span', { text: finding.category }),
            el('span', { text: finding.path ? finding.path + (finding.line ? ':' + finding.line : '') : 'no file given' }),
          ]),
          el('p', { text: finding.summary }),
          el('p', { class: 'rec', text: 'Suggested fix: ' + finding.remediation }),
        ]));
      }
      if (!report.findings.length) body.push(el('p', { class: 'prose', text: 'It found nothing worth flagging.' }));
    }
    if (view.remediation) {
      body.push(el('div', { class: 'subhead', text: 'It fixed its own findings once' }));
      body.push(el('p', { class: 'prose', text: view.remediation.summary }));
      body.push(list('Files it touched', view.remediation.changedPaths));
      body.push(list('Checks it ran', view.remediation.testsRun));
    }
    if (view.evidence) {
      body.push(el('div', { class: 'subhead', text: 'What was actually checked' }));
      body.push(evGrid(patchCells(view.evidence)));
      body.push(gateGrid(view.evidence.gates));
      body.push(list('Files it touched', view.evidence.changedPaths));
      body.push(list('Policy problems', view.evidence.policyViolations));
    }
    body.push(list('Claims it verified', report && report.testedClaims));
    body.push(list('Risks it is leaving in', report && report.residualRisks));
    return pane('What the review found', report ? report.verdict : review.status, body.filter(Boolean));
  }

  if (stageId === 'publish') {
    const publication = card.publication;
    const recovery = card.publicationRecovery;
    if (!publication) return pane('Ship', '', [el('p', { class: 'prose', text: 'Nothing has been prepared for GitHub. That is a separate decision you have not made yet.' })]);
    const body = [el('p', { class: 'prose', text: publication.blockedReason || publication.error || describePublication(publication) })];
    if (publication.pullUrl) {
      body.push(el('div', { class: 'btnrow' }, [
        el('button', { class: 'btn', text: 'Open PR #' + publication.pullNumber, onclick: () => window.open(publication.pullUrl, '_blank', 'noopener,noreferrer') }),
      ]));
    }
    if (publication.checks && publication.checks.length) {
      body.push(el('div', { class: 'subhead', text: 'Checks GitHub reported' }));
      body.push(evGrid(publication.checks.map((check) => [check.name, (check.conclusion || check.status).replace(/_/g, ' '), check.conclusion === 'success' ? 'ok' : check.conclusion ? 'bad' : ''])));
    }
    body.push(list('Checks that must pass', publication.requiredCheckNames));
    if (recovery) {
      body.push(el('div', { class: 'subhead', text: 'Rebuilt on the latest main' }));
      const rebase = recovery.rebase;
      body.push(el('p', { class: 'prose', text: rebase ? (rebase.detail || 'The rebuild is ' + rebase.status + '.') : 'No rebuild has been started.' }));
      if (rebase) body.push(evGrid([
        ['Model calls', '0'],
        ['Files replayed', String(rebase.replayedChangedPaths.length)],
        ['Tests', rebase.gates.filter((gate) => gate.status === 'passed').length + ' of ' + rebase.gates.length + ' passed'],
      ]));
      if (recovery.review) {
        body.push(el('div', { class: 'subhead', text: 'The fresh review' }));
        body.push(el('p', { class: 'prose', text: recovery.review.report ? recovery.review.report.summary : (recovery.review.blockReason || 'The review is ' + recovery.review.status + '.') }));
      }
      if (recovery.resolution) {
        body.push(el('div', { class: 'subhead', text: 'Shipped another way' }));
        body.push(el('p', { class: 'prose', text: recovery.resolution.reason }));
      }
    }
    return pane('Getting it out', publication.status.replace(/_/g, ' '), body.filter(Boolean));
  }

  const publication = card.publication;
  return pane('Merged', '', [el('p', { class: 'prose', text: publication && publication.status === 'merged' ? 'You merged this. It is done.' : 'Not merged. Bobsled never merges anything — that is always yours.' })]);
}

function describePublication(publication) {
  if (publication.status === 'pending') return 'Everything is ready. Opening it on GitHub is one more explicit step.';
  if (publication.status === 'running') return 'Pushing the branch and opening the draft pull request now.';
  if (publication.status === 'ready_for_human') return 'The draft PR is open and its checks passed. Merging is yours.';
  if (publication.status === 'merged') return 'You merged the pull request.';
  return 'The draft publication is ' + publication.status.replace(/_/g, ' ') + '.';
}

function patchCells(evidence) {
  return [
    ['The change', (evidence.filesChanged || 0) + ' files, ' + (evidence.diffLines || 0) + ' lines'],
    ['Your branch', evidence.headMoved ? 'moved' : 'untouched', evidence.headMoved ? 'bad' : 'ok'],
    ['Protected files', (evidence.protectedPaths || []).length ? (evidence.protectedPaths.length + ' touched') : 'none touched', (evidence.protectedPaths || []).length ? 'bad' : 'ok'],
    ['Patch fingerprint', String(evidence.diffSha256 || '').slice(0, 12) || 'none', 'v'],
  ];
}

function evGrid(cells) {
  return el('div', { class: 'evgrid' }, cells.map((cell) => el('div', { class: 'evcell' }, [
    el('label', { text: cell[0] }),
    el('b', { class: cell[2] === 'v' ? 'v' : (cell[2] || ''), text: cell[1] }),
  ])));
}

function gateGrid(gates) {
  if (!gates || !gates.length) return null;
  return evGrid(gates.map((gate) => [gate.id, gate.status, gate.status === 'passed' ? 'ok' : 'bad']));
}

/* ---------- timeline + actions ---------- */

const EVENT_NAMES = {
  'run.admitted': 'You queued it up',
  'run.cancelled': 'You dropped it',
  'run.override': 'You approved it anyway',
  'attempt.started': 'Started writing code',
  'attempt.succeeded': 'Finished writing the change',
  'attempt.failed': 'The attempt broke',
  'attempt.blocked': 'The attempt was stopped',
  'review.started': 'Second opinion started',
  'review.approved': 'Review found nothing blocking',
  'review.blocked': 'Review said no',
  'publication.created': 'Draft PR prepared',
  'publication.published': 'Opened on GitHub',
  'publication.merged': 'You merged it',
};

function timelinePane(card) {
  const events = card.run.audit.slice().reverse();
  return pane('What happened', String(events.length) + ' events', [
    el('div', { class: 'tl' }, events.map((event) => el('div', { class: event.type.includes('blocked') || event.type.includes('failed') ? 'hot' : '' }, [
      el('b', { text: EVENT_NAMES[event.type] || event.type.replace(/[._]/g, ' ') }),
      el('em', { text: clock(event.createdAt) + ' · ' + event.actorId }),
    ]))),
  ]);
}

function actionBar(card) {
  const bar = el('div', { class: 'actionbar' });
  for (const action of card.actions) bar.append(actionButton(card, action));
  if (card.lane === 'working' || card.lane === 'review') {
    bar.append(el('button', { class: 'btn', text: 'Watch it work', onclick: () => navigate('/runs/' + card.id + '/live') }));
  }
  const review = (card.run.jobs[0] && card.run.jobs[0].reviews || []).slice(-1)[0];
  const next = review && review.operatorView && review.operatorView.nextAction;
  if (next && next.guidance) bar.append(el('span', { class: 'note', text: next.guidance }));
  return bar;
}

/* ---------- rewrite from findings ---------- */

function openRewrite(card) {
  const job = card.run.jobs[0];
  const review = (job.reviews || []).slice(-1)[0];
  const report = review && review.operatorView && review.operatorView.primaryReport;
  const blocking = report ? report.findings.filter((finding) => finding.blocking) : [];
  const guidance = blocking.map((finding) => '- ' + finding.summary + '\n  Needs: ' + finding.remediation).join('\n');
  const body = job.workItemSnapshot.body + (guidance ? '\n\nWhat the review said has to change:\n' + guidance : '');
  sessionStorage.setItem('bobsled.draft', JSON.stringify({ title: job.workItemSnapshot.title, body: body, repositoryId: card.repositoryId }));
  navigate('/intake?draft=1');
}
`;
