# Linux deployment

Bobsled's production contract is an unprivileged Linux container or virtual machine with a locked service account. The checked-in Incus cloud-init and systemd unit are templates: review their resource, network, user, and filesystem assumptions before applying them to another host.

## Runtime layout

- Replaceable application release: `/opt/bobsled/current`
- Durable Flue and factory databases: `/var/lib/bobsled/data`
- Repository sources, credential-free tool caches, disposable worktrees, and evidence: `/var/lib/bobsled/workspaces`
- Protected runtime configuration and OAuth state: `/etc/bobsled`
- Service account and unit: locked `bobsled` user and `bobsled.service`
- HTTP: loopback or private network only until authenticated ingress is deliberately configured

The systemd unit gives the service a read-only system view and permits writes only to protected configuration, durable data, and workspaces. Releases are replaceable; state does not live beneath `/opt/bobsled`.

## Deployment contract

1. Build and install dependencies inside Linux so native modules match the target architecture.
2. Keep application releases immutable and versioned; activate them by changing the `/opt/bobsled/current` symlink.
3. Keep the previous release until the new health check passes so rollback is a symlink change rather than a rebuild.
4. Set `BOBSLED_DATA_DIR`, `BOBSLED_WORKSPACE_DIR`, and repository source paths to durable locations outside the release.
5. Keep OAuth and GitHub App configuration outside the release and readable only by the service account.
6. Use a temporary data directory during staged verification so importing the application cannot create state beneath the release.
7. Normalize staged ownership and traversal permissions before activation; source archives can otherwise preserve restrictive developer modes.
8. Back up durable databases and protected configuration separately from application releases. Treat verified webhook bodies and complete Flue observations as sensitive.

Store the GitHub App private key as a separate PEM file rather than multiline dotenv content. A typical protected deployment uses `/etc/bobsled/github-app.pem`, owned by `root:bobsled` with mode `0640`, and sets `BOBSLED_GITHUB_PRIVATE_KEY_FILE=/etc/bobsled/github-app.pem`. Transfer the downloaded PEM directly to the host; do not paste it into chat, command arguments, logs, or repository files. After proving a newly generated key can mint a scoped installation token, revoke the superseded key in GitHub and remove any legacy `BOBSLED_GITHUB_PRIVATE_KEY` assignment.

## GitHub ingress

GitHub integration requires a stable HTTPS origin and a narrowly configured reverse proxy or tunnel:

1. Route the GitHub webhook path to `/channels/github/webhook`.
2. Route the registered OAuth callback to `/auth/github/callback`.
3. Put the operator UI behind Bobsled's authenticated session boundary or an equally strong private access layer.
4. Do not expose raw agent routes.
5. Preserve `@flue/github` signature verification and Bobsled's durable delivery-deduplication boundary.
6. Restrict operator OAuth to active members of the configured organization.
7. Keep installation tokens server-side, short-lived, and repository-scoped.

Webhook admission must remain unavailable until a protected webhook secret is configured. GitHub operator mode must fail closed until its client credentials, session secret, and exact HTTPS public origin are all valid.

### Caddy reference boundary

[`deploy/caddy/Caddyfile.example`](../deploy/caddy/Caddyfile.example) is the reviewed reference for `bobsled.frostyard.org`. It deliberately:

- lets Caddy own public TLS and certificate renewal;
- proxies to a private-network `BOBSLED_UPSTREAM` rather than embedding deployment-specific addressing in source;
- returns `404` for `/agents` and `/agents/*` before a request can reach Flue's raw agent routes;
- sends every remaining request to Bobsled, where the GitHub session boundary protects the board and control-plane API; and
- uses `/health` only as an upstream liveness check.

Caddy sets `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host` for HTTP upstreams by default and ignores spoofed inbound values unless another proxy has explicitly been trusted. Do not replace those defaults with client-supplied forwarding headers. Do not enable unredacted access logging: the OAuth callback query contains short-lived authorization material, and webhook headers contain signature evidence.

Keep the current private endpoint working during activation. A host Ethernet bridge is not required for this topology; changing the host's live uplink is a separate, console-backed infrastructure migration with an independent rollback plan.

### Fail-closed activation order

1. Confirm the private upstream responds to `GET /health`; do not remove the existing Incus proxy or other known-good route.
2. Store a new, random `BOBSLED_SESSION_SECRET` of at least 32 bytes in protected service configuration. Never put it in source, the Caddyfile, shell arguments, logs, or chat.
3. Set `BOBSLED_PUBLIC_ORIGIN=https://bobsled.frostyard.org` and `BOBSLED_OPERATOR_AUTH_MODE=github` alongside the already-protected GitHub client credentials.
4. Register exactly `https://bobsled.frostyard.org/auth/github/callback` as the GitHub App callback URL.
5. Configure `BOBSLED_UPSTREAM` for the Caddy service with the private endpoint, import the reference site block, and validate the complete Caddy configuration before reload.
6. Restart Bobsled while it is still reachable only through the private route. Verify `/health` reports operator mode `github`; an incomplete configuration must instead report `github_unconfigured` and fail protected routes closed.
7. Reload Caddy, then prove that HTTPS is valid, `/` redirects an unauthenticated browser to GitHub, `/api/repositories` returns `401` without a session, and `/agents/bobsled` returns `404` at ingress.
8. Complete an interactive login with an active `frostyard` member and verify a protected read-only request plus logout. Keep the prior Caddy configuration and Bobsled release available for rollback until this succeeds.
9. Configure the GitHub App webhook URL as `https://bobsled.frostyard.org/channels/github/webhook` only after its matching protected webhook secret is installed. Prove a GitHub `ping`, a deduplicated delivery, and a rejected invalid signature before enabling event-driven dispatch.

The OAuth proof requires a human browser, and the webhook secret must be entered independently into GitHub and protected host configuration. Neither value belongs in repository history or command output.

### Local-trusted history cutover

A deployment that previously admitted work in `local_trusted` mode retains those records under the synthetic `local-operator` owner. GitHub authentication deliberately does not make another principal's records visible, so the board will initially appear empty even though the history remains intact.

After the intended operator has completed GitHub login, an administrator may explicitly transfer that legacy history with:

```sh
BOBSLED_DATA_DIR=/var/lib/bobsled/data npm run migrate:local-operator -- --confirm-single-active-github-user
```

The migration refuses to run unless exactly one distinct, unexpired `frostyard` GitHub principal has an active session. It checks all owner-scoped idempotency keys for conflicts, atomically transfers runs plus related issue actions and draft publications, and appends `run.owner_transferred` audit evidence without rewriting historical actor IDs. It is idempotent and prints only transfer counts, not the principal's identity or session data. Back up the database before invoking it.

## Subscription authentication

Each host authenticates Codex and Copilot independently. Never copy `auth.json` between development and production: two hosts refreshing cloned OAuth state can invalidate one another.

Run `npm run auth:codex` and `npm run auth:copilot` interactively as the service user with `BOBSLED_AUTH_FILE` pointing at the protected host credential path. Pairing or browser authorization happens directly between the operator and provider; never relay authorization codes through chat or logs.

After authentication, restart the service and run `npm run auth:status` under the same environment. The status command reports provider presence without displaying credential values.

## Release verification

Before activation, run:

```sh
npm ci
npm test
npm run check:types
npm run build
npm audit --omit=dev
```

After activation, verify `/health`, confirm the service has not entered a restart loop, and retain the previous release until the new version has handled representative read-only requests successfully.
