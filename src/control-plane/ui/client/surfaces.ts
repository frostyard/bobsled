export const surfacesSource = String.raw`
/* ---------- access ---------- */

async function accessSurface(surface) {
  setTopbar([el('div', { class: 'crumbs' }, [el('b', { text: 'Access' }), el('span', { text: ' · what Bobsled can reach' })])]);
  const body = el('div', { class: 'pane-body' });
  surface.append(el('div', { class: 'col-pane' }, [
    el('div', { class: 'pane-head' }, [el('h2', { text: 'GitHub' })]),
    body,
  ]));

  const [authority, status, observability, fleet, repositoryDrift, enrollments] = await Promise.all([
    json('/api/github-app/authority').catch((error) => ({ error: message(error) })),
    json('/api/github-app/status').catch(() => undefined),
    json('/api/observability/status').catch(() => undefined),
    json('/api/operations/fleet').catch(() => undefined),
    json('/api/repositories/drift').catch(() => undefined),
    json('/api/repository-enrollments').catch(() => []),
  ]);

  if (authority.error) {
    body.append(el('div', { class: 'inline-error' }, [el('b', { text: 'Could not check GitHub access.' }), el('span', { text: authority.error })]));
  } else if (authority.status === 'within_policy') {
    body.append(el('div', { class: 'verdict' }, [
      el('div', { class: 'tags' }, [el('span', { class: 'tag ok', text: 'Looks right' })]),
      el('h3', { text: 'GitHub access looks right.' }),
      el('p', { class: 'prose', text: 'The App has exactly the permissions it is supposed to have, and nothing more.' }),
    ]));
  } else if (authority.status === 'unobserved') {
    body.append(el('div', { class: 'verdict', 'data-route': 'needs_human' }, [
      el('div', { class: 'tags' }, [el('span', { class: 'tag warn', text: 'Nothing seen yet' })]),
      el('h3', { text: 'Bobsled has not heard from GitHub yet.' }),
      el('p', { class: 'prose', text: 'Access gets checked the first time GitHub tells us about the installation.' }),
    ]));
  } else {
    body.append(el('div', { class: 'inline-error' }, [
      el('b', { text: 'The GitHub App has more access than it should.' }),
      el('span', { text: 'Beyond what Bobsled declares it needs: ' + (authority.excessPermissions || []).map((entry) => entry.name).join(', ') + '.' }),
    ]));
  }

  if (status) {
    body.append(el('div', { class: 'subhead', text: 'Installation' }));
    body.append(evGrid([
      ['Configured', status.configured ? 'yes' : 'no', status.configured ? 'ok' : 'bad'],
      ['Webhooks seen', String((status.webhooks && status.webhooks.total) || 0)],
      ['Last webhook', (status.webhooks && status.webhooks.lastEventAt) ? ago(status.webhooks.lastEventAt) : 'never'],
    ]));
  }
  if (observability) {
    body.append(el('div', { class: 'subhead', text: 'What Bobsled has recorded' }));
    body.append(evGrid([
      ['Agent events', String(observability.total || 0)],
      ['Stored', Math.round((observability.storedBytes || 0) / 1024) + ' KB'],
      ['Last seen', observability.lastObservedAt ? ago(observability.lastObservedAt) : 'never'],
    ]));
  }
  if (fleet) {
	const capacity = fleet.organization.capacityPolicy;
    body.append(el('div', { class: 'subhead', text: 'Fleet capacity' }));
    body.append(evGrid([
      ['Queued runs', String(fleet.organization.workload.pendingRuns)],
      ['Active runs', String(fleet.organization.workload.activeRuns)],
      ['Active attempts', String(fleet.organization.workload.activeAttempts)],
      ['Active reviews', String(fleet.organization.workload.activeReviews)],
      ['Active publications', String(fleet.organization.workload.activePublications)],
	  ['Organization ceiling', capacity ? String(capacity.maxActiveWorkflows) + ' workflows' : 'not configured'],
	  ['Enforcement', fleet.organization.enforcementMode === 'disabled' ? 'observe only' : fleet.organization.enforcementMode],
	  ['Claimed workflows', String(fleet.organization.capacityUsage.activeWorkflows)],
	  ['Claimed provider calls', String(fleet.organization.capacityUsage.providerCalls.openaiCodex) + ' Codex · ' + String(fleet.organization.capacityUsage.providerCalls.githubCopilot) + ' Copilot'],
	  ['Would exceed limits', String(fleet.organization.capacityUsage.wouldExceedPolicyClaims)],
	  ['Expired claims', String(fleet.organization.capacityUsage.expiredClaims)],
	  ['Ambiguous claims', String(fleet.organization.capacityUsage.ambiguousClaims)],
      ['Active worker plans', String(fleet.organization.multiWorkerQuota.activePlans)],
      ['Worker attempts', String(fleet.organization.multiWorkerQuota.workerAttempts.used) + ' / ' + String(fleet.organization.multiWorkerQuota.workerAttempts.declared)],
      ['Codex calls', String(fleet.organization.multiWorkerQuota.subscriptionCalls.openaiCodex.used) + ' / ' + String(fleet.organization.multiWorkerQuota.subscriptionCalls.openaiCodex.declared)],
      ['Copilot calls', String(fleet.organization.multiWorkerQuota.subscriptionCalls.githubCopilot.used) + ' / ' + String(fleet.organization.multiWorkerQuota.subscriptionCalls.githubCopilot.declared)],
      ['Observation retention', fleet.observability.retentionMode],
    ]));
	const total = el('input', { type: 'number', min: '1', max: '32', value: capacity ? capacity.maxActiveWorkflows : '4', 'aria-label': 'Maximum active workflows' });
	const codex = el('input', { type: 'number', min: '1', max: '32', value: capacity ? capacity.providerConcurrentCalls.openaiCodex : '2', 'aria-label': 'Maximum concurrent Codex calls' });
	const copilot = el('input', { type: 'number', min: '1', max: '32', value: capacity ? capacity.providerConcurrentCalls.githubCopilot : '2', 'aria-label': 'Maximum concurrent Copilot calls' });
	body.append(el('div', { class: 'filerow' }, [
	  el('label', { text: 'Workflows ' }, [total]), el('label', { text: 'Codex ' }, [codex]), el('label', { text: 'Copilot ' }, [copilot]),
	  el('button', { class: 'btn', text: capacity ? 'Update limits' : 'Set limits', onclick: async () => {
		const policy = { maxActiveWorkflows: Number(total.value), providerConcurrentCalls: { openaiCodex: Number(codex.value), githubCopilot: Number(copilot.value) } };
		const decision = await authorize('configure_capacity_policy', { subject: 'Frostyard organization capacity' }); if (!decision.ok) return;
		try { await post('/api/operations/capacity-policy', { policy: policy, expectedVersion: capacity ? capacity.version : 0, reason: decision.reason }); toast('Fleet limits recorded in observe-only mode.'); render(); }
		catch (error) { fail(error, body); }
	  }}),
	]));
	if (fleet.organization.capacityUsage.expiredClaims > 0) body.append(el('div', { class: 'btnrow' }, [el('button', { class: 'btn', text: 'Reconcile expired claims', onclick: async () => {
	  const decision = await authorize('recover_capacity_claims', { subject: String(fleet.organization.capacityUsage.expiredClaims) + ' expired provider claim(s)' }); if (!decision.ok) return;
	  try { const result = await post('/api/operations/capacity-claims/recover-expired', { reason: decision.reason }); toast(String(result.recoveredClaims) + ' expired claim(s) recorded as ambiguous.'); render(); }
	  catch (error) { fail(error, body); }
	}})]));
  }

  body.append(el('div', { class: 'subhead', text: 'Repositories' }));
  body.append(el('div', { class: 'btnrow' }, [el('button', { class: 'btn', text: 'Check repository drift', onclick: async () => {
    try { await post('/api/repositories/drift/check', {}); toast('Repository drift observations recorded.'); render(); }
    catch (error) { fail(error, body); }
  } })]));
  const grid = el('div', { style: 'display:grid;gap:8px' });
  const managedRepositories = enrollments.length ? enrollments : state.repositories.map((repository) => ({ repository: repository, version: 1 }));
  for (const enrollment of managedRepositories) {
    const repository = enrollment.repository;
    const drift = repositoryDrift && repositoryDrift.find((entry) => entry.repositoryId === repository.id);
    const driftLabel = !drift ? 'not checked' : drift.status === 'aligned' ? 'aligned' : drift.status === 'drifted' ? 'drift found' : 'unavailable';
    const impact = drift && drift.policyImpact && drift.policyImpact.changedOpenRunCount ? ' · ' + drift.policyImpact.changedOpenRunCount + ' open run' + (drift.policyImpact.changedOpenRunCount === 1 ? '' : 's') + ' use older policy' : '';
    const detail = (!drift || !drift.findings.length ? '' : ' · ' + drift.findings.map((finding) => finding.kind.replace(/_/g, ' ')).join(', ')) + impact;
    const controls = [];
    if (repository.enabled !== false) controls.push(el('button', { class: 'btn', text: 'Disable', onclick: async () => {
      const decision = await authorize('disable_repository', { subject: repository.id });
      if (!decision.ok) return;
      await post('/api/repository-enrollments/' + repository.id + '/disable', { expectedVersion: enrollment.version, reason: decision.reason });
      toast('Repository disabled.'); render();
    }}));
    else controls.push(el('button', { class: 'btn primary', text: 'Enable', onclick: async () => {
      const decision = await authorize('enable_repository', { subject: repository.id });
      if (!decision.ok) return;
      await post('/api/repository-enrollments', { repositoryId: repository.id, expectedVersion: enrollment.version, reason: decision.reason });
      toast('Repository enabled with its current GitHub policy.'); render();
    }}));
    grid.append(el('div', { class: 'filerow' }, [
      el('span', { text: repository.id }),
      el('span', { class: 'pm', text: (repository.enabled !== false ? (repository.readOnly ? 'read only' : 'can write') : 'disabled') + ' · v' + enrollment.version + ' · ' + driftLabel + detail }),
      ...controls,
    ]));
  }
  body.append(grid);
  const discovery = el('div', { style: 'display:grid;gap:8px' });
  body.append(el('div', { class: 'btnrow' }, [el('button', { class: 'btn', text: 'Find installed repositories', onclick: async () => {
    clear(discovery).append(el('span', { class: 'pm', text: 'Checking GitHub…' }));
    try {
      const candidates = await json('/api/repository-enrollments/discover'); clear(discovery);
      for (const candidate of candidates.filter((entry) => !entry.enrolled)) discovery.append(el('div', { class: 'filerow' }, [
        el('span', { text: candidate.id }),
        el('button', { class: 'btn primary', text: 'Enroll', onclick: async () => {
          const decision = await authorize('enroll_repository', { subject: candidate.id }); if (!decision.ok) return;
          await post('/api/repository-enrollments', { repositoryId: candidate.id, expectedVersion: 0, reason: decision.reason });
          toast('Repository enrolled.'); render();
        }}),
      ]));
      if (!discovery.children.length) discovery.append(el('span', { class: 'pm', text: 'Every installed repository is already enrolled.' }));
    } catch (error) { fail(error, discovery); }
  }} )]));
  body.append(discovery);
  return undefined;
}

/* ---------- activity ---------- */

async function activitySurface(surface) {
  setTopbar([
    el('div', { class: 'crumbs' }, [el('b', { text: 'Activity' }), el('span', { text: ' · everything, newest first' })]),
    el('button', { class: 'btn spacer', text: 'Refresh', onclick: () => render() }),
  ]);
  if (!state.cards.length) await loadBoardQuietly();

  const events = [];
  for (const card of state.cards) {
    if (state.scope && card.repositoryId !== state.scope) continue;
    for (const event of card.run.audit) {
      events.push({ card: card, type: event.type, actorId: event.actorId, at: event.createdAt });
    }
  }
  events.sort((left, right) => right.at.localeCompare(left.at));

  const body = el('div', { class: 'pane-body' });
  surface.append(el('div', { class: 'col-pane' }, [
    el('div', { class: 'pane-head' }, [el('h2', { text: 'What has been happening' }), el('span', { class: 'pane-note', text: events.length + ' events' })]),
    body,
  ]));

  if (!events.length) {
    body.append(el('div', { class: 'center-note' }, [
      el('h2', { text: 'Nothing has happened yet.' }),
      el('p', { text: 'Queue something up and it will show here.' }),
    ]));
    return undefined;
  }

  let lastDay = '';
  let holder;
  for (const event of events.slice(0, 300)) {
    const day = new Date(event.at).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      holder = el('div', { class: 'tl' });
      body.append(el('div', { class: 'subhead', text: day }), holder);
    }
    const node = el('div', { class: event.type.includes('blocked') || event.type.includes('failed') ? 'hot' : '' }, [
      el('b', { text: EVENT_NAMES[event.type] || event.type.replace(/[._]/g, ' ') }),
      el('em', { text: clock(event.at) + ' · ' + event.card.title }),
    ]);
    node.style.cursor = 'pointer';
    node.addEventListener('click', () => navigate('/runs/' + event.card.id));
    holder.append(node);
  }
  return undefined;
}

/* ---------- change sets ---------- */

async function changeSetsSurface(surface) {
  setTopbar([el('div', { class: 'crumbs' }, [el('b', { text: 'Change sets' }), el('span', { text: ' · work that spans repositories' })])]);
  surface.append(el('div', { class: 'center-note' }, [
    el('h2', { text: 'No change sets yet.' }),
    el('p', { class: 'prose', text: 'A change set coordinates one piece of work across several repositories: dependency order, compatibility checks between them, and a rollout that stops at the first failure. The machinery is built and tested; nothing has used it yet, so there is nothing to show.' }),
    el('p', { class: 'prose', text: 'When the first one exists, this is where its members, their order, and their rollout state will live.' }),
  ]));
  return undefined;
}
`;
