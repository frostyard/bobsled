# GitHub App capability plan

Bobsled's GitHub authority expands by milestone. The App is not an agent tool: only trusted control-plane code may mint installation tokens or perform mutations.

## M2 registration

Install the App only on explicitly enrolled repositories. Start with:

- Repository metadata: read (implicit GitHub App baseline).
- Issues: read and write, for policy-controlled labels and comments.
- Webhook events: issues, issue comments, installation, and installation repositories.

Do not grant Contents, Pull requests, Workflows, Administration, Actions, or Checks write access in M2. Add capabilities when a milestone needs them:

- M3: Contents read for cloning private repositories.
- M4: Contents write and Pull requests write for branches and draft PRs; Checks read for verification.
- Workflows write remains excluded unless a separately approved product requirement demands it.

Permission changes are versioned policy changes, not assumptions baked into jobs. Existing installations may continue with their prior grant until an owner approves expansion.

## Operator login

Use the same organization-owned GitHub App's user authorization flow for Bobsled operator login rather than introducing a separate classic OAuth App. Request read-only organization Members permission and accept a callback only when the authenticated user's membership in `frostyard` is active. Organization membership establishes who may enter the control plane; Bobsled's own roles, repository enrollment, job ownership, and approval policy still determine what that principal may do.

The OAuth callback and webhook receiver will be the only initial public paths. The operator UI and agent conversation routes remain private behind authenticated sessions.

The implementation uses the GitHub App web flow with PKCE S256, random one-use state, and the exact configured callback URL. It discards the user access token after looking up the user and verifying the authenticated user's `frostyard` membership is `active`. Sessions are opaque, signed, durable, revocable, and expire after eight hours; cookie values are never accepted as principal identifiers.

`BOBSLED_OPERATOR_AUTH_MODE=github` remains fail-closed until all of the following protected settings are present and valid:

- `BOBSLED_GITHUB_CLIENT_ID`
- `BOBSLED_GITHUB_CLIENT_SECRET`
- `BOBSLED_SESSION_SECRET` (at least 32 bytes)
- `BOBSLED_PUBLIC_ORIGIN` (an HTTPS origin with no path, query, or fragment)

The registered callback URL must be `<public-origin>/auth/github/callback`. Supply values only through protected deployment configuration, never source, shell arguments, logs, or chat.

## Runtime boundary

- Obtain short-lived installation tokens only in the trusted control plane.
- Narrow each token to the target repository and required permission subset.
- Never expose installation tokens, the App private key, or webhook secret to agents, prompts, logs, browser responses, or repository workspaces.
- Verify `X-Hub-Signature-256` against the exact request bytes before parsing a webhook.
- Retain exact verified request bytes and deduplicate delivery IDs before creating work.
- Reject signed installation or repository payloads outside the `frostyard` organization.
- Snapshot installation identity and effective permissions when admitting a job.

`GET /api/github-app/status` reports only whether required configuration is present. Supply credentials through the deployment's protected secret store; do not put them in source, shell commands, or chat.

Prefer `BOBSLED_GITHUB_PRIVATE_KEY_FILE` over inline `BOBSLED_GITHUB_PRIVATE_KEY` in deployed services. Store the complete downloaded PEM as a separate root-owned file readable by the service group. A configured file path is authoritative and fails closed when unreadable; Bobsled never falls back to stale inline key material. This avoids dotenv quoting errors and prevents systemd from treating PEM continuation lines as separate environment assignments.

The receiver is implemented at `POST /channels/github/webhook` but stays unavailable until `BOBSLED_GITHUB_WEBHOOK_SECRET` is supplied through protected deployment configuration. The official `@flue/github` channel owns JSON admission, exact-byte HMAC verification, GitHub event typing, and ping acknowledgement. A bounded project-owned wrapper retains the same exact bytes and atomically claims the verified delivery in Bobsled's store. Unknown valid event names are recorded with `ignored` status so GitHub can evolve without causing retries or accidental execution. No admitted webhook currently dispatches an agent or performs a GitHub write.

The generated blueprint's single `GITHUB_TOKEN` and direct comment tool are intentionally not used. Outbound authority remains the repository-ID-scoped GitHub App broker and durable action outbox described below.

The installation-token broker uses the enrolled repository's immutable GitHub database ID, not its mutable name, and exposes typed permission profiles rather than arbitrary permission objects. The public `frostyard/clix` enrollment is the representative read-only policy fixture. Callers receive a callback-scoped authenticated request function rather than a token; it cannot override the API origin or authorization header and stops working after the callback. Token values are never returned or persisted.

The issue-action outbox is implemented but clix policy still has `readOnly: true` and `writeGitHub: false`. Consequently, action admission records an explicit block and execution stops before token minting. Enabling writes requires both a working App installation and a reviewed repository-policy change. Label execution may change only Bobsled's route-label vocabulary; comment execution uses a durable marker to reconcile retries without duplicate public comments.

The M4 publication outbox follows the same policy-first rule. Its write token is narrowed to the enrolled repository and the `contents:write` plus `pull_requests:write` profile; check polling uses a separate `checks:read` profile. Publication accepts no arbitrary repository, branch, ref update, commit, or PR mode from a model. It binds the approved patch digest and base commit, creates deterministic Git objects, refuses force-push, creates drafts only, and verifies a recovered PR still points to the exact approved commit. Required check names are snapshotted at admission and combined with any later policy tightening. There is no merge endpoint. clix explicitly keeps publication disabled, so the implementation can be deployed and inspected without minting a token or touching GitHub.

## Optionality rule

Insufficient App authority must produce a clear blocked capability, not an agent retry loop. A human may grant a narrowly scoped permission, choose a non-GitHub/local workflow, or supersede the run. Bobsled records that decision and continues from a stable boundary.
