# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or exposed credential. Use GitHub's private vulnerability-reporting form for this repository. If that form is unavailable, contact a Frostyard organization owner privately and include only the minimum information needed to establish a secure follow-up channel.

Never include access tokens, OAuth refresh state, GitHub App private keys, webhook secrets, session cookies, raw webhook bodies, or Flue observation payloads in a report, issue, pull request, or log excerpt.

## Supported versions

Bobsled is pre-1.0 software. Security fixes are applied to the default branch; older commits and private deployments are not maintained as separate release lines.

## Security boundaries

- The development server is for trusted local use unless GitHub operator authentication and a deliberate HTTPS isolation boundary are complete.
- Agent sandboxes are not credential boundaries. Trusted control-plane code owns credentials, repository enrollment, policy, gates, and every GitHub mutation.
- GitHub publication is draft-only and repository-scoped. Bobsled has no merge operation.
- OAuth state, databases, verified webhook inputs, observations, and workspaces belong outside the source repository in protected host storage.

Please include the affected boundary, reproduction conditions, and potential impact in a private report. Avoid testing against repositories or accounts you do not control.
