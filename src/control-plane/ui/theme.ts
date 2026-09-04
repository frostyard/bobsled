// Design tokens and component styles for the operator interface.
//
// Two rules hold this together:
//   1. Type is split by role. Sans carries the interface; mono is reserved for
//      values that are exact -- digests, SHAs, ids, paths, gate names. Mono
//      therefore *means* "this is a literal value".
//   2. The accent is the primary action and nothing else. Status has its own
//      semantic colours, which are the same everywhere they appear.
//
// No web fonts: this is a local tool and must look right with no network.

export const styles = String.raw`
:root {
  color-scheme: dark;

  --bg:        #0c110f;
  --surface:   #131a17;
  --raised:    #18211d;
  --line:      #263029;
  --line-2:    #35423a;
  --text:      #e6ebe6;
  --text-2:    #9aa79f;
  --text-3:    #6d7b74;

  --accent:    #d5ff55;
  --accent-ink:#101508;
  --working:   #5fc8ff;
  --review:    #bc8cff;
  --ok:        #6ee7b7;
  --warn:      #f0c060;
  --danger:    #ff8a7a;

  --danger-line: #6b3227;
  --danger-bg:   #40201b;
  --ok-line:     #2c5c4a;
  --add-bg:      #10241a;
  --add-fg:      #a7e8c4;
  --del-bg:      #26130f;
  --del-fg:      #f2ab9d;

  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px;

  --sans: 'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  --rail: 180px;
}

@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg:        #f4f6f4;
    --surface:   #ffffff;
    --raised:    #ecefec;
    --line:      #dbe1dc;
    --line-2:    #c2ccc4;
    --text:      #131a16;
    --text-2:    #4d5b53;
    --text-3:    #74827a;

    --accent:    #5d7d0c;
    --accent-ink:#ffffff;
    --working:   #0b6ea8;
    --review:    #6b3fa8;
    --ok:        #0d6b4c;
    --warn:      #8a6410;
    --danger:    #a8341f;

    --danger-line: #e0b4a9;
    --danger-bg:   #f7e2dc;
    --ok-line:     #a9d5c2;
    --add-bg:      #e2f5ea;
    --add-fg:      #14603f;
    --del-bg:      #fbe5e0;
    --del-fg:      #8f2d1a;
  }
}

* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: var(--sans); font-size: 13px; line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
a { color: inherit; }

/* ---------- app frame ---------- */
.app { display: grid; grid-template-columns: var(--rail) minmax(0,1fr); min-height: 100vh; }
.rail { border-right: 1px solid var(--line); display: flex; flex-direction: column; padding: 14px 0; position: sticky; top: 0; height: 100vh; }
.mark { font-size: 17px; font-weight: 700; letter-spacing: .04em; padding: 0 14px 14px; }
.mark i { color: var(--accent); font-style: normal; }
.rail-label { font-family: var(--mono); font-size: 9.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--text-3); padding: 0 14px 6px; }
.scope { margin: 0 10px 16px; }
.scope select {
  width: 100%; border: 1px solid var(--line-2); background: var(--surface); color: var(--text);
  padding: 6px 8px; font-family: var(--mono); font-size: 11px;
}
.nav { display: grid; gap: 1px; }
.nav a {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 8px 14px; color: var(--text-2); text-decoration: none; border-left: 2px solid transparent;
}
.nav a:hover { color: var(--text); }
.nav a[aria-current="page"] { color: var(--text); background: var(--surface); border-left-color: var(--accent); }
.pip { font-family: var(--mono); font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--line-2); color: var(--text-2); }
.pip.alarm { background: var(--danger-bg); color: var(--danger); }
.pip[hidden] { display: none; }
.rail-foot { margin-top: auto; padding: 12px 14px 0; border-top: 1px solid var(--line); display: grid; gap: 6px; }
.opchip { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--text-2); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: none; }
.rail-foot a { font-size: 11px; color: var(--text-3); text-decoration: none; }
.rail-foot a:hover { color: var(--text-2); text-decoration: underline; }

.main { display: flex; flex-direction: column; min-width: 0; }
.topbar { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.crumbs { font-size: 12.5px; color: var(--text-2); min-width: 0; }
.crumbs b { color: var(--text); font-weight: 500; }
.crumbs a { color: var(--text-2); text-decoration: none; }
.crumbs a:hover { color: var(--text); text-decoration: underline; }
.spacer { margin-left: auto; }
.stat {
  display: flex; align-items: center; gap: 6px; padding: 4px 9px; border: 1px solid var(--line-2);
  font-family: var(--mono); font-size: 10.5px; color: var(--text-2); white-space: nowrap;
}
.stat.alarm { border-color: var(--danger-line); color: var(--danger); }
.stat.good { border-color: var(--ok-line); color: var(--ok); }
.stat[hidden] { display: none; }
.surface { flex: 1; display: flex; flex-direction: column; min-width: 0; }

/* ---------- controls ---------- */
input, select, textarea, button { font: inherit; color: inherit; }
input[type=search], input[type=text], textarea, select {
  border: 1px solid var(--line-2); background: var(--bg); color: var(--text); padding: 6px 8px;
}
textarea { width: 100%; resize: vertical; font-family: var(--sans); }
.btn {
  font-size: 11.5px; font-weight: 500; padding: 5px 10px; border: 1px solid var(--line-2);
  background: transparent; color: var(--text-2); cursor: pointer;
}
.btn:hover:not(:disabled) { color: var(--text); border-color: var(--text-3); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 600; }
.btn.primary:hover:not(:disabled) { filter: brightness(1.08); color: var(--accent-ink); }
.btn.danger { border-color: var(--danger-line); color: var(--danger); }
.btn.ghost { border-color: transparent; color: var(--text-3); }
.btn.ghost:hover:not(:disabled) { color: var(--text-2); }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btnrow { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }

/* ---------- board ---------- */
.board { display: grid; grid-template-columns: repeat(5, minmax(240px,1fr)); gap: 1px; background: var(--line); flex: 1; overflow-x: auto; }
.lane { background: var(--bg); display: flex; flex-direction: column; min-width: 240px; }
.lane-head { padding: 11px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 1; }
.lane-title { display: flex; align-items: center; gap: 7px; }
.lane-title strong { font-family: var(--mono); font-size: 10.5px; letter-spacing: .11em; text-transform: uppercase; font-weight: 600; }
.lane-title .n { margin-left: auto; font-family: var(--mono); font-size: 10.5px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.lane-def { font-size: 10.5px; color: var(--text-3); line-height: 1.35; margin-top: 5px; }
.lane-cards { padding: 9px; display: grid; gap: 8px; align-content: start; }
.lane-empty { font-size: 10.5px; color: var(--text-3); padding: 6px 2px; }
.lane[data-lane=ready]     .lane-title strong, .lane[data-lane=ready] .dot     { color: var(--accent);  }
.lane[data-lane=working]   .lane-title strong { color: var(--working); }
.lane[data-lane=review]    .lane-title strong { color: var(--review);  }
.lane[data-lane=delivery]  .lane-title strong { color: var(--ok);      }
.lane[data-lane=attention] .lane-title strong { color: var(--danger);  }
.lane[data-lane=ready]     .dot { background: var(--accent);  }
.lane[data-lane=working]   .dot { background: var(--working); }
.lane[data-lane=review]    .dot { background: var(--review);  }
.lane[data-lane=delivery]  .dot { background: var(--ok);      }
.lane[data-lane=attention] .dot { background: var(--danger);  }

.card {
  background: var(--surface); border: 1px solid var(--line-2); border-left-width: 2px;
  padding: 9px 10px 8px; display: grid; gap: 6px; text-align: left; width: 100%;
  font: inherit; color: inherit; cursor: pointer;
}
.card:hover { border-color: var(--text-3); }
.card[data-lane=ready]     { border-left-color: var(--accent);  }
.card[data-lane=working]   { border-left-color: var(--working); }
.card[data-lane=review]    { border-left-color: var(--review);  }
.card[data-lane=delivery]  { border-left-color: var(--ok);      }
.card[data-lane=attention] { border-left-color: var(--danger);  }
.card[data-lane=history]   { border-left-color: var(--line-2);  }
.card-top { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 9.5px; color: var(--text-3); }
.card-top .phase { margin-left: auto; color: var(--text-2); text-align: right; }
.card h3 { margin: 0; font-size: 12.5px; font-weight: 500; line-height: 1.3; }
.card .why { font-size: 11px; color: var(--text-2); line-height: 1.4; }
.card .why.alarm { color: var(--danger); }
.metrics {
  display: flex; flex-wrap: wrap; gap: 4px 10px; font-family: var(--mono); font-size: 10px;
  color: var(--text-3); border-top: 1px solid var(--line); padding-top: 6px; font-variant-numeric: tabular-nums;
}
.micro { display: flex; align-items: center; gap: 3px; }
.micro i { height: 3px; background: var(--line-2); display: block; flex: 1; }
.micro i.done { background: var(--ok); }
.micro i.now { background: var(--working); }

.done-strip { border-top: 1px solid var(--line); background: var(--bg); }
.done-strip > summary { cursor: pointer; padding: 10px 16px; font-family: var(--mono); font-size: 10.5px; letter-spacing: .11em; text-transform: uppercase; color: var(--text-2); }
.done-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px,1fr)); gap: 8px; padding: 0 16px 16px; }

/* ---------- generic panes ---------- */
.pane-head { padding: 10px 12px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pane-head h2 { margin: 0; font-family: var(--mono); font-size: 10.5px; letter-spacing: .11em; text-transform: uppercase; font-weight: 600; color: var(--text-2); }
.pane-note { margin-left: auto; font-family: var(--mono); font-size: 10px; color: var(--text-3); }
.pane-body { padding: 12px; display: grid; gap: 10px; align-content: start; overflow: auto; }
.col-pane { background: var(--bg); display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
.prose { max-width: 68ch; font-size: 13px; color: var(--text-2); line-height: 1.6; }
.prose b, .prose strong { color: var(--text); font-weight: 500; }
.mono { font-family: var(--mono); }
.center-note { padding: 48px 16px; text-align: center; color: var(--text-3); display: grid; gap: 10px; justify-items: center; }
.center-note h2 { margin: 0; font-size: 15px; color: var(--text); font-weight: 500; }

/* ---------- run page ---------- */
.stagerail { display: flex; gap: 1px; background: var(--line); border-bottom: 1px solid var(--line); overflow-x: auto; }
.stage {
  flex: 1 0 150px; background: var(--bg); padding: 10px 12px; display: grid; gap: 4px; text-align: left;
  border: 0; border-top: 2px solid var(--line-2); font: inherit; color: inherit; cursor: pointer;
}
.stage:hover { background: var(--surface); }
.stage[aria-selected=true] { background: var(--surface); }
.stage strong { font-family: var(--mono); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; }
.stage span { font-size: 11px; color: var(--text-3); }
.stage[data-state=done] { border-top-color: var(--ok); }
.stage[data-state=done] strong { color: var(--ok); }
.stage[data-state=active] { border-top-color: var(--working); }
.stage[data-state=active] strong { color: var(--working); }
.stage[data-state=blocked] { border-top-color: var(--danger); }
.stage[data-state=blocked] strong { color: var(--danger); }
.stage[data-state=blocked] span { color: var(--danger); }
.stage[data-state=todo] { opacity: .5; }
.detail { display: grid; grid-template-columns: minmax(0,1fr) 280px; gap: 1px; background: var(--line); flex: 1; min-height: 0; }
@media (max-width: 1000px) { .detail { grid-template-columns: 1fr; } }

.finding-row { border: 1px solid var(--line); border-left: 2px solid var(--danger); background: var(--surface); padding: 9px 11px; display: grid; gap: 5px; }
.finding-row[data-severity=minor] { border-left-color: var(--warn); }
.finding-row .fid { font-family: var(--mono); font-size: 9.5px; color: var(--text-3); display: flex; gap: 8px; flex-wrap: wrap; }
.finding-row .fid b { color: var(--danger); }
.finding-row[data-severity=minor] .fid b { color: var(--warn); }
.finding-row p { margin: 0; font-size: 11.5px; line-height: 1.5; }
.finding-row .rec { color: var(--text-2); }
.evgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px,1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
.evcell { background: var(--surface); padding: 8px 9px; display: grid; gap: 3px; min-width: 0; }
.evcell label { font-family: var(--mono); font-size: 9px; letter-spacing: .09em; text-transform: uppercase; color: var(--text-3); }
.evcell b { font-size: 12.5px; font-weight: 500; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.evcell b.v { font-family: var(--mono); font-size: 10.5px; font-weight: 400; }
.evcell b.ok { color: var(--ok); } .evcell b.bad { color: var(--danger); }
.tl { display: grid; }
.tl div { border-left: 1px solid var(--line-2); padding: 0 0 11px 12px; position: relative; font-size: 11px; color: var(--text-2); }
.tl div::before { content: ""; position: absolute; left: -3.5px; top: 5px; width: 6px; height: 6px; border-radius: 50%; background: var(--line-2); }
.tl div.hot::before { background: var(--danger); }
.tl div b { display: block; color: var(--text); font-weight: 500; }
.tl div em { font-style: normal; font-family: var(--mono); font-size: 9.5px; color: var(--text-3); }
.actionbar { border-top: 1px solid var(--line); padding: 10px 16px; display: flex; gap: 8px; align-items: center; background: var(--surface); flex-wrap: wrap; }
.actionbar .note { font-size: 11px; color: var(--text-3); margin-left: auto; }
.plainlist { margin: 0; padding-left: 18px; font-size: 11.5px; color: var(--text-2); display: grid; gap: 2px; }
.plainlist li { overflow-wrap: anywhere; }
.subhead { font-family: var(--mono); font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--text-3); }

/* ---------- live view ---------- */
.watchbar { display: flex; align-items: center; gap: 10px; padding: 9px 16px; border-bottom: 1px solid var(--line); background: var(--surface); flex-wrap: wrap; }
.livedot { width: 7px; height: 7px; border-radius: 50%; background: var(--working); flex: none; box-shadow: 0 0 0 0 rgba(95,200,255,.55); animation: pulse 2s ease-out infinite; }
.livedot[data-idle=true] { background: var(--text-3); animation: none; }
@keyframes pulse { 70% { box-shadow: 0 0 0 6px rgba(95,200,255,0); } 100% { box-shadow: 0 0 0 0 rgba(95,200,255,0); } }
.watchbar .lbl { font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--working); }
.watchbar .ro { font-size: 11px; color: var(--text-3); max-width: 62ch; }
.watchgrid { display: grid; grid-template-columns: minmax(0,1fr) 400px; gap: 1px; background: var(--line); flex: 1; min-height: 0; }
@media (max-width: 1100px) { .watchgrid { grid-template-columns: 1fr; } }
.stream { display: grid; align-content: start; overflow: auto; }
.srow { display: grid; grid-template-columns: 48px minmax(0,1fr); gap: 10px; align-items: baseline; padding: 6px 12px; border-bottom: 1px solid var(--line); }
.srow time { font-family: var(--mono); font-size: 9.5px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.srow .what { font-size: 11.5px; color: var(--text-2); line-height: 1.5; overflow-wrap: anywhere; }
.srow .what b { font-weight: 500; color: var(--text); }
.srow[data-kind=tool] .what b { color: var(--working); font-family: var(--mono); font-size: 10.5px; }
.srow[data-kind=gate] .what b { color: var(--ok); font-family: var(--mono); font-size: 10.5px; }
.srow[data-kind=gate][data-bad=true] .what b { color: var(--danger); }
.srow[data-kind=says] { background: var(--surface); }
.srow[data-kind=says] .what { color: var(--text); }
.srow[data-kind=says] .what em { font-style: normal; color: var(--text-3); font-family: var(--mono); font-size: 9.5px; display: block; margin-bottom: 2px; letter-spacing: .09em; text-transform: uppercase; }
.filerow { display: flex; align-items: center; gap: 8px; padding: 5px 9px; border: 1px solid var(--line); background: var(--surface); font-family: var(--mono); font-size: 10px; color: var(--text-2); }
.filerow .pm { margin-left: auto; font-variant-numeric: tabular-nums; white-space: nowrap; }
.filerow .p, .evcell .p { color: var(--ok); } .filerow .m, .evcell .m { color: var(--danger); }
.difffile { border: 1px solid var(--line); background: var(--bg); overflow: hidden; }
.difffile > header { display: flex; gap: 8px; align-items: center; padding: 6px 9px; border-bottom: 1px solid var(--line); font-family: var(--mono); font-size: 10px; color: var(--text-2); }
.difflines { overflow-x: auto; }
.dl { font-family: var(--mono); font-size: 10px; line-height: 1.6; padding: 0 9px; white-space: pre; color: var(--text-3); }
.dl.add { background: var(--add-bg); color: var(--add-fg); }
.dl.del { background: var(--del-bg); color: var(--del-fg); }
.dl.hdr { background: var(--surface); }

/* ---------- intake ---------- */
.stepper { display: flex; border-bottom: 1px solid var(--line); padding: 0 12px; overflow-x: auto; }
.step { display: flex; align-items: center; gap: 7px; padding: 11px 14px; border-bottom: 2px solid transparent; font-size: 12px; color: var(--text-3); white-space: nowrap; }
.step b { width: 17px; height: 17px; border-radius: 50%; border: 1px solid var(--line-2); display: grid; place-items: center; font-family: var(--mono); font-size: 9.5px; font-weight: 500; }
.step[data-state=done] { color: var(--text-2); }
.step[data-state=done] b { background: var(--ok); border-color: var(--ok); color: var(--bg); }
.step[data-state=now] { color: var(--text); border-bottom-color: var(--accent); }
.step[data-state=now] b { border-color: var(--accent); color: var(--accent); }
.step-sep { align-self: center; color: var(--line-2); }
.triptych { display: grid; grid-template-columns: 250px minmax(0,1fr) 300px; gap: 1px; background: var(--line); flex: 1; min-height: 0; }
@media (max-width: 1100px) { .triptych { grid-template-columns: 1fr; } }
.seg { display: flex; border: 1px solid var(--line-2); }
.seg button { flex: 1; text-align: center; padding: 5px 4px; font-size: 11px; color: var(--text-3); background: transparent; border: 0; cursor: pointer; }
.seg button[aria-pressed=true] { background: var(--raised); color: var(--text); }
.srcitem { border: 1px solid var(--line); background: var(--surface); padding: 8px 9px; display: grid; gap: 4px; text-align: left; font: inherit; color: inherit; cursor: pointer; width: 100%; }
.srcitem:hover { border-color: var(--text-3); }
.srcitem[aria-current=true] { border-color: var(--accent); }
.srcitem strong { font-size: 11.5px; font-weight: 500; line-height: 1.3; }
.srcitem em { font-style: normal; font-family: var(--mono); font-size: 9.5px; color: var(--text-3); }
.turn { border-left: 2px solid var(--working); background: var(--surface); padding: 8px 10px; display: grid; gap: 4px; }
.turn[data-role=assistant] { border-left-color: var(--accent); }
.turn label { font-family: var(--mono); font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--text-3); }
.turn p { margin: 0; font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.composer { margin-top: auto; border-top: 1px solid var(--line); padding: 10px 12px; display: grid; gap: 8px; }
.composer textarea { min-height: 58px; font-size: 12px; }
.briefblock { border-top: 1px solid var(--line); padding-top: 8px; display: grid; gap: 4px; }
.briefblock:first-child { border-top: 0; padding-top: 0; }
.briefblock label { font-family: var(--mono); font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); display: flex; justify-content: space-between; gap: 8px; }
.briefblock label i { font-style: normal; color: var(--text-3); }
.briefblock ul { margin: 0; padding-left: 15px; font-size: 11.5px; color: var(--text-2); }
.briefblock li { margin-bottom: 2px; overflow-wrap: anywhere; }
.briefblock p { margin: 0; font-size: 11.5px; color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; }
.gate-note { border: 1px solid var(--line-2); border-left: 2px solid var(--warn); background: var(--surface); padding: 8px 10px; font-size: 11px; color: var(--text-2); line-height: 1.5; }
.gate-note b { color: var(--warn); }
.verdict { border: 1px solid var(--line-2); border-left: 2px solid var(--accent); background: var(--surface); padding: 10px 12px; display: grid; gap: 6px; }
.verdict[data-route=needs_human] { border-left-color: var(--warn); }
.verdict h3 { margin: 0; font-size: 12.5px; font-weight: 500; }
.verdict .tags { display: flex; gap: 6px; flex-wrap: wrap; }
.tag { font-family: var(--mono); font-size: 9.5px; letter-spacing: .06em; text-transform: uppercase; border: 1px solid var(--line-2); padding: 2px 6px; color: var(--text-2); }
.tag.ok { border-color: var(--ok-line); color: var(--ok); }
.tag.warn { border-color: var(--warn); color: var(--warn); }

/* ---------- authorization sheet ---------- */
dialog.sheet {
  width: min(660px, calc(100vw - 32px)); padding: 0; border: 1px solid var(--line-2);
  background: var(--surface); color: var(--text); box-shadow: 0 30px 80px rgba(0,0,0,.55);
}
dialog.sheet::backdrop { background: rgba(5,8,6,.66); }
.sheet-head { padding: 16px 18px 14px; border-bottom: 1px solid var(--line); display: grid; gap: 5px; }
.sheet-head h2 { margin: 0; font-size: 16px; font-weight: 600; }
.sheet-head em { font-style: normal; font-family: var(--mono); font-size: 10.5px; color: var(--text-3); overflow-wrap: anywhere; }
.grants { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--line); border-bottom: 1px solid var(--line); }
@media (max-width: 560px) { .grants { grid-template-columns: 1fr; } }
.grants > div { background: var(--surface); padding: 13px 16px; }
.grants h3 { margin: 0 0 8px; font-family: var(--mono); font-size: 9.5px; letter-spacing: .11em; text-transform: uppercase; }
.grants .yes h3 { color: var(--ok); }
.grants .no h3 { color: var(--danger); }
.grants ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 5px; }
.grants li { font-size: 11.5px; color: var(--text-2); padding-left: 15px; position: relative; line-height: 1.4; }
.grants .yes li::before { content: "+"; position: absolute; left: 0; color: var(--ok); font-family: var(--mono); }
.grants .no li::before { content: "\2013"; position: absolute; left: 0; color: var(--danger); font-family: var(--mono); }
.bound { padding: 12px 16px; border-bottom: 1px solid var(--line); display: grid; grid-template-columns: repeat(auto-fit,minmax(130px,1fr)); gap: 12px; }
.bound div { display: grid; gap: 3px; min-width: 0; }
.bound label { font-family: var(--mono); font-size: 9px; letter-spacing: .09em; text-transform: uppercase; color: var(--text-3); }
.bound b { font-family: var(--mono); font-size: 11px; font-weight: 400; overflow-wrap: anywhere; }
.sheet-note { padding: 10px 16px; border-bottom: 1px solid var(--line); font-size: 11.5px; color: var(--warn); }
.sheet-foot { padding: 14px 16px; display: grid; gap: 10px; }
.fieldlabel { font-family: var(--mono); font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--text-3); display: block; margin-bottom: 6px; }
.sheet-foot .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.sheet-foot .row .note { font-size: 10.5px; color: var(--text-3); margin-left: auto; font-family: var(--mono); }
.sheet-error { color: var(--danger); font-size: 11.5px; }
.sheet-error:empty { display: none; }

/* ---------- toasts + inline errors ---------- */
.toasts { position: fixed; right: 16px; bottom: 16px; display: grid; gap: 8px; z-index: 60; width: min(380px, calc(100vw - 32px)); }
.toast {
  border: 1px solid var(--line-2); border-left: 2px solid var(--ok); background: var(--raised);
  padding: 10px 12px; display: grid; gap: 4px; box-shadow: 0 10px 30px rgba(0,0,0,.4);
}
.toast[data-tone=bad] { border-left-color: var(--danger); }
.toast[data-tone=busy] { border-left-color: var(--working); }
.toast b { font-size: 12px; font-weight: 500; }
.toast p { margin: 0; font-size: 11.5px; color: var(--text-2); overflow-wrap: anywhere; }
.toast .btnrow { margin-top: 2px; }
.inline-error {
  border: 1px solid var(--danger-line); border-left-width: 2px; background: var(--danger-bg);
  color: var(--danger); padding: 9px 11px; font-size: 11.5px; display: grid; gap: 6px;
}
.inline-error:empty { display: none; }
.inline-error b { font-weight: 500; }

@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
@media (max-width: 760px) {
  .app { grid-template-columns: 1fr; }
  .rail { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px; border-right: 0; border-bottom: 1px solid var(--line); padding: 10px 12px; }
  .mark { padding: 0; } .scope { margin: 0; min-width: 150px; } .rail-label { display: none; }
  .nav { grid-auto-flow: column; gap: 4px; } .nav a { border-left: 0; border-bottom: 2px solid transparent; padding: 6px 8px; }
  .nav a[aria-current="page"] { border-left: 0; border-bottom-color: var(--accent); }
  .rail-foot { margin: 0; border-top: 0; padding: 0; }
}
`;
