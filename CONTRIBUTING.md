# Contributing to Bobsled

## Development setup

1. Install Node.js 22.19 or newer.
2. Run `npm ci`.
3. Copy the names you need from `.env.example` into a protected environment file outside the repository.
4. Run `npm test`, `npm run check:types`, and `npm run build` before submitting a change.

Codex or Copilot OAuth is required only for live agent tests. Deterministic tests must not require subscriptions, credentials, network access, or a running GitHub App.

## Design rules

- Runtime schemas and TypeScript types must agree at every model and control-plane boundary.
- Model output is evidence, never authorization.
- Repository policy and trusted quality gates outrank agent recommendations.
- Keep credentials, runtime databases, observations, webhook bodies, workspaces, and private deployment evidence outside the repository.
- New GitHub authority must be typed, repository-scoped, disabled by default, and tested to stop before token minting when policy denies it.
- Preserve failed and superseded evidence rather than rewriting history.
- Do not add automated merge authority.

## Pull requests

Keep changes bounded and explain:

- the problem and intended behavior;
- affected schemas, policies, and authority boundaries;
- deterministic verification performed;
- any migration, rollback, observability, or compatibility impact.

Use synthetic fixtures with reserved domains and obviously invalid credential values. Never paste sanitized-looking copies of real credentials or production payloads.
