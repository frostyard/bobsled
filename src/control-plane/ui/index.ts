import { styles } from './theme.ts';
import { AUTHORITY, BRIEF_FIELDS, FOOTER, HISTORY_LANE, LANES, SURFACES } from './copy.ts';
import { coreSource } from './client/core.ts';
import { actionsSource } from './client/actions.ts';
import { boardSource } from './client/board.ts';
import { runSource } from './client/run.ts';
import { liveSource } from './client/live.ts';
import { intakeSource } from './client/intake.ts';
import { surfacesSource } from './client/surfaces.ts';
import { bootSource } from './client/boot.ts';

export interface ControlPlaneIdentity {
	provider: 'github' | 'local';
	login?: string;
}

function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/**
 * Serializes server-owned values into the client module.
 *
 * `</script` inside a JSON string would end the script element early, so it is
 * escaped along with the line separators JSON allows but JavaScript does not.
 */
function embed(value: unknown): string {
	return JSON.stringify(value)
		.replaceAll('<', '\\u003c')
		.replaceAll(' ', '\\u2028')
		.replaceAll(' ', '\\u2029');
}

const copy = {
	LANES,
	HISTORY: HISTORY_LANE,
	AUTHORITY,
	SURFACES,
	BRIEF_FIELDS,
};

export function controlPlaneHtml(identity: ControlPlaneIdentity): string {
	const label = identity.provider === 'github' ? `@${identity.login ?? 'unknown'}` : 'Local operator';
	return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bobsled</title>
  <style>${styles}</style>
</head>
<body>
<div class="app" id="app">
  <div class="main">
    <div class="topbar" id="topbar"></div>
    <div class="surface" id="surface"></div>
    <footer class="topbar" style="border-top:1px solid var(--line);border-bottom:0">
      <span style="font-size:11px;color:var(--text-3)">${escapeHtml(FOOTER)}</span>
    </footer>
  </div>
</div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<dialog class="sheet" id="sheet" aria-labelledby="sheet-title"></dialog>
<script type="module">
const COPY = ${embed(copy)};
const IDENTITY = ${embed({ provider: identity.provider, label })};
${coreSource}
${actionsSource}
${boardSource}
${runSource}
${liveSource}
${intakeSource}
${surfacesSource}
${bootSource}
</script>
</body>
</html>`;
}
