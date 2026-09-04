# Repository enrollment

Bobsled discovers repositories visible to its Frostyard GitHub App installation, but discovery alone grants no work authority. Enrollment requires a reviewed policy at `.bobsled/repository.json` on the repository's current default branch.

GitHub—not the file or browser—supplies the canonical `owner/name`, immutable repository ID, description, and default branch. The policy file supplies only Bobsled capabilities and limits. It is schema validated before an authenticated operator can create a versioned enrollment record.

```json
{
  "version": 1,
  "readOnly": true,
  "agentSurfaces": ["AGENTS.md", "README.md"],
  "qualityGates": [{ "id": "test", "name": "Tests", "command": "npm test", "kind": "full", "mutatesWorkspace": false }],
  "protectedBoundaries": [],
  "capabilities": { "read": true, "triage": true, "writeCode": false, "writeGitHub": false, "merge": false },
  "multiRepo": { "coordinateWith": [], "compatibilityGates": [] },
  "executionPolicy": { "enabled": false, "maxFiles": 8, "maxDiffLines": 500, "requiredGateIds": ["test"], "workerTimeoutMinutes": 20, "gateTimeoutMinutes": 15, "workerNetwork": { "mode": "none" } },
  "multiWorkerPolicy": { "enabled": false, "maxConcurrentWorkers": 2, "maxWorkerAttempts": 8, "maxPreDispatchRetriesPerTask": 1, "maxRuntimeMinutes": 60, "subscriptionCalls": { "openaiCodex": 4, "githubCopilot": 2 } },
  "reviewPolicy": { "enabled": false, "maxRemediationRounds": 0, "reviewerTimeoutMinutes": 15, "remediationTimeoutMinutes": 20 },
  "publicationPolicy": { "enabled": false, "branchPrefix": "bobsled/", "draftPullRequestsOnly": true, "allowForcePush": false, "requiredCheckNames": ["test"], "maxAttempts": 3, "maxTotalBlobBytes": 5242880 },
  "workspacePreparation": { "name": "Install locked dependencies", "command": "npm ci", "timeoutMinutes": 15, "networkAccess": true }
}
```

Start conservatively: keep execution, review, publication, multi-worker operation, and GitHub writes disabled until the repository's real gates and preparation command are reviewed. `merge` must always be `false`.

On **Access**, select **Find installed repositories**, then **Enroll**. Bobsled re-fetches GitHub metadata and the policy during the confirmed action; it does not trust the discovery list or browser to resubmit policy. **Disable** appends a new policy version that blocks new intake and scoped authority while preserving every prior version and run. **Enable** re-fetches canonical metadata and the current policy before appending another enabled version; it never restores stale policy implicitly. None of these actions starts work, calls a model, mutates GitHub, merges, or deploys.
