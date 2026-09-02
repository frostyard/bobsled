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
