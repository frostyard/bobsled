# AGENTS.md

This is a [Flue](https://flueframework.com) project: agents are TypeScript functions.

## Layout

- `src/agents/` — agent modules. A module whose first line is the `'use agent'` directive exports agents: every exported capitalized function is one, and the function name is its durable identity.
- `src/app.ts` — the route map; every route is mounted here explicitly.
- `src/control-plane/` — schema contracts, enrolled repository policy, read-only intake, triage orchestration, and the local UI.
- `ROADMAP.md` — durable milestone and safety-boundary status; update it whenever a milestone changes.
- `src/db.ts` — the persistence adapter for durable conversations.

## Commands

- `npx flue run src/agents/hello.ts --message "Hi"` — run an agent locally, no server.
- `npm run dev` — start the dev server.
- `npm run build` — build `dist/server.mjs` (start it with `npm run start`).
- `npm run check:types` — typecheck.
- `npm test` — run deterministic Node tests.
- `npx flue docs search <query>` — search the Flue docs from the terminal (then `flue docs read <path>`).
- `npx flue add` — list blueprints for adding channels, sandboxes, and databases.
