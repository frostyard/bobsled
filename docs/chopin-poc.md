# Chopin integration assessment and proof of concept

Status: proposed

## Summary

[Chopin](https://github.com/githubnext/chopin) is a GitHub Next research prototype for collaboratively authoring repository-grounded plans, specifications, RFCs, proposals, and decision records. It is a strong potential upstream planning surface for Bobsled, provided the integration preserves a strict ownership boundary:

- Chopin owns collaborative exploration, research, questions, decisions, and specification authoring.
- Bobsled owns repository enrollment, immutable intake, policy snapshots, execution authorization, bounded workspaces, independent review, quality gates, draft publication, and audit history.

The recommended proof of concept imports an immutable Chopin document snapshot into Bobsled for normal triage and admission. It must not delegate execution authority to Chopin or adopt Chopin's experimental implementation lifecycle.

## Why the fit is timely

Bobsled's current pipeline already provides the downstream controls that Chopin intentionally does not:

- M2 supplies authenticated operator access, durable admission, verified webhook intake, permission auditing, and bounded GitHub issue actions.
- M3 supplies explicit execution authorization, disposable workspaces, trusted patch computation, protected-boundary enforcement, and repository-declared quality gates.
- M4 supplies automatic independent review, bounded remediation, exact-patch draft publication, and durable evidence.
- M5 now defines versioned dependency graphs and literal file or directory ownership scopes for prospective parallel work.

Bobsled's current intake remains comparatively small: a GitHub issue or manual task becomes a schema-validated work item and is sent through read-only triage. Chopin can improve the information entering that boundary without weakening the controls after it.

## Responsibility boundary

| Responsibility | Authoritative system |
| --- | --- |
| Explore requirements and alternatives | Chopin |
| Record questions, comments, research, and decisions | Chopin |
| Produce a settled implementation specification | Chopin |
| Snapshot and validate a submitted specification | Bobsled |
| Enforce repository enrollment and policy | Bobsled |
| Derive and validate worker file scopes | Bobsled |
| Authorize execution | Bobsled operator |
| Execute, review, gate, and publish | Bobsled |

Chopin content is planning input, not authority. A document's association with a GitHub repository does not enroll that repository in Bobsled, and Chopin's approval state does not authorize Bobsled execution.

## Relevant Chopin capabilities

Chopin combines a repository-connected collaborative document with shared chat, attributed decisions, comments, research, and a read-only hosted Planner. Its Streamable HTTP MCP endpoint lets external agents list and read documents and exposes an experimental implementation handoff.

The experimental handoff is notably similar to Bobsled M5. It contains:

- ordered tasks, dependency edges, and acceptance criteria;
- separate plan, graph-version, and graph-revision counters;
- human-only graph approval in the domain model;
- atomic graph claims;
- idempotent task, pull-request, and verification reports; and
- whole-graph verification before successful completion.

However, it is not currently a complete product workflow. Chopin documents that the web application has no user-facing graph approval path, and the supported `read_implementation` path is limited to documents created through MCP. The graph also has no equivalent of Bobsled's literal file-ownership scopes.

For those reasons, a Chopin graph should be treated as a planning proposal. A validated Bobsled work plan remains the execution contract.

## Current technical seam

Chopin's `read_document` MCP tool returns a stable document UUID, canonical document source, and plan revision. That is sufficient for an initial import. The normal document read does not expose all question, comment, and decision provenance, while `read_implementation` depends on the incomplete graph-approval workflow.

The first integration should therefore import the canonical document, not claim Chopin's graph or report into its execution lifecycle.

Conceptually, the flow is:

```text
Chopin collaborative document
        |
        | explicit operator import
        v
Bobsled immutable source snapshot
        |
        | normalized, schema-bounded projection
        v
Bobsled triage and durable admission
        |
        | explicit Go fix this authorization
        v
Bobsled execution -> review -> gates -> draft PR
```

## Recommended proof of concept

### 1. Add a durable source snapshot

Store the exact imported document separately from the compact `WorkItem` projection:

```ts
interface ChopinDocumentSnapshot {
	version: 1;
	instanceOrigin: string;
	documentId: string;
	canonicalUrl: string;
	repositoryId: string;
	documentRevision: number;
	source: string;
	sourceSha256: string;
	importedAt: string;
}
```

The stored bytes, revision, and digest become immutable run evidence. A later Chopin edit creates a new import or superseding Bobsled run; it never changes evidence attached to an admitted run.

### 2. Add a read-only Chopin connector

The connector should expose only the document-read operation needed by the POC and enforce:

- one configured Chopin origin;
- HTTPS outside loopback development;
- strict timeouts and response-size limits;
- no redirects to arbitrary origins;
- schema validation of the MCP response;
- no document, graph, or lifecycle mutations; and
- no credentials or authorization headers in logs or ledger artifacts.

Restricted MDX returned by Chopin remains untrusted input. Bobsled must normalize it to inert Markdown or plain text before rendering it or adding it to an agent prompt. It must never execute imported MDX components.

### 3. Add an explicit operator import

The operator flow should be:

1. Enter or select a Chopin document URL.
2. Fetch and validate the document.
3. Display its repository, title, revision, digest, and normalized preview.
4. Explicitly choose **Import for triage**.
5. Run the existing Bobsled triage and admission flow.

Importing does not authorize implementation. Only an admitted run appears in the operator board's Ready lane, and **Go fix this** remains the explicit authorization for a bounded implementation and review attempt.

### 4. Produce a Bobsled-owned work plan

For the first POC, Chopin provides the specification and acceptance language. Bobsled produces and validates its own `MultiWorkerPlanV2`, including file scopes.

A later adapter could map Chopin graph fields as follows:

| Chopin | Bobsled |
| --- | --- |
| `id` | `id` |
| `title` | `title` |
| `context` and `goal` | `objective` |
| `acceptance` | `acceptanceCriteria` |
| `dependsOn` | `dependsOn` |
| no equivalent | `fileScopes`, derived and reviewed in Bobsled |

Every imported graph must pass Bobsled's versioned schema, dependency, cycle, and file-scope checks. Neither a valid import nor a readiness projection grants fan-out, workspace leases, retry, runtime, or token-spend authority.

### 5. Prove the trust boundary

Focused tests should demonstrate that:

- importing the same document revision is idempotent;
- a changed revision creates a new immutable snapshot;
- the document repository must match an enrolled Bobsled repository;
- malformed, malicious, or unsupported MDX remains inert;
- oversized or invalid documents fail before model invocation;
- a failed Chopin request admits no work;
- imported content cannot select repositories or modify policy;
- importing never dispatches workers automatically; and
- later Chopin edits cannot mutate an admitted run's evidence.

## Authentication considerations

Chopin MCP callers provide their own GitHub user bearer token. Chopin independently applies instance admission and checks that user's repository access. Bobsled's operator OAuth currently uses its GitHub token to establish the operator identity and Frostyard membership, then retains a Bobsled session and principal rather than the GitHub bearer token. The existing Bobsled login therefore cannot transparently authenticate to Chopin MCP.

For a bounded POC, use a separately managed, host-injected credential for a dedicated read-only importer and retain explicit operator confirmation in Bobsled. Do not place the credential in repository configuration, command arguments, URLs, logs, or durable intake artifacts.

For a production integration, choose between:

1. an explicit delegated GitHub connection whose short-lived token remains process-local; or
2. a signed, read-only Chopin export endpoint intended for service-to-service consumption.

The second option creates the cleaner long-term boundary but requires a Chopin change.

Bobsled's Codex and Copilot subscription OAuth remains independent. Chopin is only an upstream planning source and does not determine which provider Bobsled uses for implementation or review.

## Explicit non-goals

The POC should not:

- let Chopin start, retry, cancel, or otherwise mutate a Bobsled run;
- call Chopin's `start_implementation` or lifecycle-reporting tools;
- make Chopin availability a prerequisite for reading historical Bobsled runs;
- introduce bidirectional synchronization;
- treat mutable Chopin URLs as durable evidence without a revision and digest;
- render arbitrary imported MDX; or
- enable event-triggered worker dispatch.

## Evaluation criteria

Run the POC against two or three representative tasks and compare it with issue-only intake. Continue toward a versioned graph adapter only if the Chopin-fed runs measurably provide:

- clearer acceptance criteria;
- fewer `needs_spec` or `needs_information` triage results;
- fewer implementation-time scope revisions;
- better task boundaries for Bobsled's M5 planner; or
- more useful human-review evidence.

If the richer document does not improve those outcomes, retain Chopin as an optional human planning tool and avoid a permanent control-plane dependency.

## Recommendation

Build the document-snapshot POC. The product boundary is strong: Chopin can become the collaborative place where intent is resolved, while Bobsled remains the trusted system that admits, executes, verifies, and publishes work.

Do not integrate Chopin's experimental execution lifecycle yet. First prove that immutable document import materially improves Bobsled triage and planning. If it does, define a small, versioned export contract for decision provenance and graph proposals rather than coupling Bobsled to Chopin's internal storage or lifecycle state.

## References

- [Chopin README](https://github.com/githubnext/chopin#readme)
- [Chopin architecture](https://github.com/githubnext/chopin/blob/main/docs/architecture.md)
- [Chopin local-agent MCP](https://github.com/githubnext/chopin/blob/main/docs/local-agent-mcp.md)
- [Chopin experimental implementation lifecycle](https://github.com/githubnext/chopin/blob/main/docs/implementation-lifecycle.md)
- [Bobsled roadmap](../ROADMAP.md)
- [Bobsled intake contracts](../src/control-plane/contracts.ts)
- [Bobsled M5 work-plan contracts](../src/control-plane/work-plan-contracts.ts)
- [Bobsled operator board criteria](operator-board.md)
