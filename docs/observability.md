# Flue observability retention

Bobsled treats observability as durable evidence first and a UI decision later. Flue's `observe()` API is process-global and live-only, so the application installs one subscriber from the provider bootstrap shared by the server and standalone agent entry points.

## What is retained

Every `FlueObservation` delivered after process startup is stored in `bobsled.db`. This includes all event families and the live-only observation detail that Flue does not replay: full model-visible turn requests, prompts and messages, model responses, reasoning and text deltas, tool arguments and effective results, task prompts/results, compaction, token/cost usage, structured logs, and classified errors with live stacks.

Each payload is stored twice:

1. `payload_blob` is the authoritative lossless Node V8 serialization.
2. `payload_json` is a human/query-tool-friendly projection with explicit markers for cycles, `undefined`, big integers, non-finite numbers, binary data, errors, maps, and sets.

The row also projects stable envelope and correlation fields into indexed columns. Token accounting must use one semantic level only: `turn` is the leaf, while `operation` and `compaction` usage are rollups that already include their turns.

## Deliberate exclusions

- Flue replaces raw base64 image bytes with its omission sentinel before observers run.
- Bobsled does not persist `FlueEventContext.env`.
- Request headers, cookies, authorization data, and URL query strings are not persisted.
- There is no API for raw telemetry content yet.

The retained content remains highly sensitive because it can include source code, prompts, reasoning, tool inputs/results, filesystem paths, and error stacks. The database is mode `0600` and belongs in protected durable storage and backups.

## Delivery behavior

The synchronous observer performs only cheap queueing. A microtask batches SQLite writes in one transaction; failed batches remain queued for a later retry and never affect agent execution. A clean process exit flushes the outstanding batch. Abrupt host or process failure can still lose the final in-memory batch because Flue's source stream itself is live-only and best-effort.

Current retention is indefinite. A later policy may add rotation, encryption, export, or tiered redaction, but it must be versioned and must not silently change historical evidence.
