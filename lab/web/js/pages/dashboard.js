// Dashboard: workspace overview, the honest maturity of each capability, next steps.
import { h, pageHead, panel, badge, statusBadge, fmtDate, empty } from '../ui.js';

const LEVEL_ORDER = ['planned', 'implemented', 'experimental', 'synthetic', 'real_audio', 'restricted_production'];

export function render(root, params, app) {
  const s = app.state, c = s.workspace.counts;
  const step = (done, label, go, btn) => h('div.finding' + (done ? '.ok' : ''), h('span.i', done ? '✓' : '○'), h('span', { style: { flex: 1 } }, label),
    !done && go ? h('button', { onclick: () => app.go(go) }, btn) : null);
  const anyFeedback = c.feedback_items > 0;
  root.append(
    pageHead('Dashboard', `${s.workspace.name} — ${s.workspace.root}`),
    h('div.grid.g4', { style: { marginBottom: '14px' } },
      stat(c.references, 'References'), stat(c.profiles, 'Sound Profiles'), stat(`${c.experiments_complete} / ${c.experiments}`, 'Experiments complete'),
      stat(`${c.feedback_items} · ${c.listening_trials}`, 'Feedback items · blind trials')),
    h('div.grid.g-side',
      h('div',
        panel('Capability maturity', [
          h('p.dim.small', 'Status comes from what is implemented and what evidence exists. No capability is promoted automatically; real-audio validation needs your listening evidence and sign-off.'),
          h('table', h('tr', h('th', 'Capability'), h('th', 'Status'), h('th', 'Evidence'), h('th', 'On your real audio')),
            s.capabilities.slice().sort((a, b) => LEVEL_ORDER.indexOf(b.level) - LEVEL_ORDER.indexOf(a.level)).map((x) => h('tr',
              h('td', h('b', x.name), h('div.faint.small', x.specialist)),
              h('td', badge(x.level_label, x.level)),
              h('td.small.dim', x.evidence),
              h('td.small', x.real_audio ? x.real_audio.status : h('span.faint', '–'))))),
        ]),
        panel('Recent experiments', s.recent_experiments.length ? h('table',
          h('tr', h('th', 'Name'), h('th', 'Type'), h('th', 'Status'), h('th', 'Created'), h('th', '')),
          s.recent_experiments.map((e) => h('tr.click', { onclick: () => app.go(e.type === 'study' ? `studies/${e.id}` : `listen/${e.id}`) },
            h('td', e.name, e.synthetic ? [' ', badge('synthetic data', 'synthetic-data')] : null), h('td', e.type === 'study' ? `study · ${e.study}` : e.type),
            h('td', statusBadge(e.status)), h('td.dim', fmtDate(e.created)), h('td', h('span.faint', '›')))))
          : empty('No experiments yet', 'Build a Sound Profile, then analyse a mix in the Music Lab.'), h('button.ghost', { onclick: () => app.go('history') }, 'All experiments'))),
      h('div',
        panel('First workflow', h('div',
          step(c.references > 0, 'Import a reference recording with stems', 'references', 'Import'),
          step(c.profiles > 0, 'Build a Sound Profile', 'profiles', 'Build'),
          step(c.mixes > 0, 'Import your own group stems', 'music', 'Import'),
          step(c.experiments_complete > 0, 'Analyse a mix and render the adjusted version', 'music', 'Analyse'),
          step(c.listening_trials > 0 || anyFeedback, 'Listen, compare and record feedback', 'listen', 'Listen'),
          step(false, 'Export a research package for review', 'export', 'Export'))),
        panel('Maturity levels', h('div.stack', Object.entries(s.levels).map(([k, v]) => h('div.row', badge(v, k)))),
          null),
        panel('Privacy', h('div.small.dim.stack',
          h('p', 'Runs entirely on this computer. No network services are used for analysis.'),
          h('p', 'Research exports leave out audio, file paths and credentials by default and are never uploaded automatically.'),
          h('p', 'Your feedback is stored as research data. It does not change the operator automatically.'))))));
}
function stat(v, l) { return h('div.stat', h('div.v', String(v)), h('div.l', l)); }
