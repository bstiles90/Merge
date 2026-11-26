// Engineer Feedback: everything you have recorded, across experiments. Blind and non-blind kept apart.
import { api } from '../api.js';
import { h, clear, pageHead, panel, badge, empty, fmtTime, fmtDate, fmtDb, groupName, select } from '../ui.js';

export async function render(root, params, app) {
  const r = await api.get('/api/feedback');
  const f = { kind: '', exp: '', verdict: '', category: '' };
  const body = h('div');
  const exps = [...new Map(r.items.map((x) => [x.experiment_id, x.experiment_name])).entries()];
  root.append(pageHead('Engineer Feedback', 'Your judgements of the operator’s decisions, stored as research data beside each experiment. Feedback does not change or train the operator automatically; it is evidence for review.',
    h('button', { onclick: () => app.go('export') }, 'Export for review…')),
    h('div.row', { style: { marginBottom: '10px' } },
      select([['', 'All feedback'], ['decisions', 'Decision verdicts'], ['notes', 'Timestamped notes'], ['missed', 'Missed interventions'], ['overall', 'Overall evaluations (non-blind)']], '', (v) => { f.kind = v; draw(); }),
      select([['', 'All experiments'], ...exps], '', (v) => { f.exp = v; draw(); }),
      select([['', 'Any verdict'], ...Object.entries(r.verdicts)], '', (v) => { f.verdict = v; draw(); }),
      select([['', 'Any category'], ...Object.entries(r.categories)], '', (v) => { f.category = v; draw(); })), body);
  function draw() {
    const rows = r.items.filter((x) => (!f.kind || x.kind === f.kind) && (!f.exp || x.experiment_id === f.exp) && (!f.verdict || x.verdict === f.verdict) && (!f.category || x.category === f.category));
    const verdicts = {}, cats = {};
    rows.filter((x) => x.kind === 'decisions').forEach((x) => { verdicts[x.verdict] = (verdicts[x.verdict] || 0) + 1; });
    rows.filter((x) => x.category).forEach((x) => { cats[x.category] = (cats[x.category] || 0) + 1; });
    const trials = r.trials.filter((t) => !f.exp || t.experiment_id === f.exp);
    const answered = trials.filter((t) => t.answer);
    clear(body, h('div.grid.g-side',
      h('div.panel.flat', h('div.pb', rows.length ? h('table', h('tr', h('th', 'Experiment'), h('th', 'Type'), h('th', 'When in audio'), h('th', 'Feedback'), h('th', 'Category'), h('th', 'Recorded')),
        rows.map((x) => h('tr.click', { onclick: () => app.go(`listen/${x.experiment_id}`) },
          h('td.small', x.experiment_name), h('td.small', { decisions: 'Decision', notes: 'Note', missed: 'Missed', overall: 'Overall' }[x.kind]),
          h('td.num.small', x.time_s != null ? fmtTime(x.time_s, true) : x.start_s != null ? `${fmtTime(x.start_s)}–${fmtTime(x.end_s)}` : '–'),
          h('td', describe(x, r)), h('td.small.dim', x.category ? r.categories[x.category] + (x.category_auto ? ' (auto)' : '') : ''),
          h('td.small.dim', fmtDate(x.modified || x.created))))) : empty('No feedback yet', 'Open an experiment in the Listening Room and review its decisions.'))),
      h('div',
        panel('Decision verdicts', Object.keys(verdicts).length ? h('table', Object.entries(verdicts).sort((a, b) => b[1] - a[1]).map(([k, n]) => h('tr', h('td', r.verdicts[k]), h('td.num', n)))) : h('p.dim', 'None')),
        panel('Problem categories', Object.keys(cats).length ? h('table', Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, n]) => h('tr', h('td', r.categories[k]), h('td.num', n)))) : h('p.dim', 'None')),
        panel('Blind trials (kept separately)', h('div.stack', h('p', `${answered.length} answered · ${trials.length - answered.length} unanswered`),
          answered.map((t) => h('div.small', `${t.experiment_name}: ${t.answer.choice === 'A' || t.answer.choice === 'B' ? 'preferred ' + (t.preferred_version || '?') : t.answer.choice.replace('_', ' ')}${t.answer.confidence ? ' (' + t.answer.confidence + ' confidence)' : ''}`)),
          h('p.faint.small', 'Informal blind trials. Fewer than about ten answered trials per comparison are not statistically conclusive.'))))));
  }
  draw();
}

function describe(x, r) {
  if (x.kind === 'decisions') return h('div', h('b', r.verdicts[x.verdict]), ` — ${groupName(x.target)}${x.proposed != null ? ' ' + fmtDb(x.proposed) : ''}`,
    x.preferred?.kind ? h('div.small.dim', `Preferred: ${x.preferred.kind}${x.preferred.value != null ? ' ' + fmtDb(x.preferred.value) : ''}`) : null, x.comment ? h('div.small', x.comment) : null);
  if (x.kind === 'notes') return h('div', x.text, x.version ? h('span.faint.small', ` (${x.version})`) : null);
  if (x.kind === 'missed') return h('div', h('b', groupName(x.target)), ` — ${x.issue || ''}`, x.preferred?.kind ? h('div.small.dim', `Should have: ${x.preferred.kind}${x.preferred.value != null ? ' ' + fmtDb(x.preferred.value) : ''}`) : null);
  if (x.kind === 'overall') return h('div', Object.entries(x.ratings || {}).map(([a, v]) => badge(`${a.replace(/_/g, ' ')}: ${v.replace('_', ' ')}`, v === 'improved' ? 'ok' : v === 'degraded' ? 'error' : 'info')), x.comment ? h('div.small', x.comment) : null);
  return '';
}
