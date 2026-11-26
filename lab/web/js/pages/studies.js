// Research Studies: the prototype's investigations, runnable on your own material.
import { api } from '../api.js';
import { h, clear, pageHead, panel, badge, statusBadge, empty, fmtDate, field, select, showError, md } from '../ui.js';
import { progress } from './music.js';

const STUDIES = [
  { id: 'activity', name: 'Activity detection', needs: ['mix'], text: 'How sensitive each group’s “is it playing?” detector is on your stems, and how the operator’s decisions change with the thresholds.' },
  { id: 'beta', name: 'Reference influence (β)', needs: ['mix', 'profile'], text: 'Runs the operator with β from 0 (your baseline) to 1 (fully the profile) and reports how far each setting moves the mix and how well known disturbances are corrected.' },
  { id: 'response', name: 'Evidence window & correction speed', needs: ['mix', 'profile'], text: 'Tries combinations of evidence window and correction speed: faster settings react sooner but move more.' },
  { id: 'generalization', name: 'Profile generalisation', needs: ['refs'], text: 'Leave-one-out across your references: how well a profile built from the others predicts each one. Needs at least two references.' },
  { id: 'processing', name: 'Processing vs performance', needs: ['mix'], text: 'Uses raw (pre-plugin) stems to tell whether loudness changes come from the plugins or from the musicians. Needs a mix imported with raw stems.' },
];

export async function render(root, [eid], app) {
  if (eid) return view(root, eid, app);
  const [{ items: mixes }, { items: profiles }, { items: refs }, { items: exps }] = await Promise.all([
    api.get('/api/library/mixes'), api.get('/api/profiles'), api.get('/api/library/references'), api.get('/api/experiments')]);
  const done = profiles.filter((p) => p.status === 'complete' && (p.groups || []).length);
  root.append(pageHead('Research Studies', 'Systematic investigations of the operator’s behaviour on your material. Results are research evidence only and never change any setting by themselves.'));
  const grid = h('div.grid.g2');
  for (const S of STUDIES) {
    const st = { mix: mixes[0]?.id, profile: done[0]?.id, refs: refs.map((r) => r.id) };
    const status = h('div');
    const mixOpts = (S.id === 'processing' ? mixes.filter((m) => m.raw?.length) : mixes).map((m) => [m.id, m.name]);
    if (S.id === 'processing') st.mix = mixOpts[0]?.[0];
    const missing = (S.needs.includes('mix') && !mixOpts.length) ? (S.id === 'processing' ? 'Import a mix that includes raw (pre-plugin) stems.' : 'Import a mix first.')
      : (S.needs.includes('profile') && !done.length) ? 'Build a Sound Profile first.' : (S.needs.includes('refs') && refs.length < 2) ? 'Import at least two references.' : null;
    grid.append(h('div.panel', h('div.ph', h('h2', S.name)), h('div.pb.stack', h('p.dim', S.text),
      S.needs.includes('mix') && mixOpts.length ? field('Mix', select(mixOpts, st.mix, (v) => { st.mix = v; })) : null,
      S.needs.includes('profile') && done.length ? field('Profile', select(done.map((p) => [p.id, p.name]), st.profile, (v) => { st.profile = v; })) : null,
      missing ? h('div.notice.warn', missing) : h('div.row', h('button.primary', { onclick: async () => {
        const mix = mixes.find((m) => m.id === st.mix);
        const inputs = { ...(S.needs.includes('mix') ? { mix_id: st.mix } : {}), ...(S.needs.includes('profile') ? { profile_id: st.profile } : {}), ...(S.needs.includes('refs') ? { reference_ids: st.refs } : {}) };
        try {
          const r = await api.post('/api/experiments/study', { name: `${S.name} study`, inputs, config: { study: S.id, baseline: mix?.baseline || 'all' }, injections: S.id === 'beta' || S.id === 'response' ? mix?.suggested_injections : null });
          progress(status, r, { go: () => app.go(`studies/${r.exp_id}`) });
        } catch (e) { showError(e); }
      } }, 'Run study')), status)));
  }
  root.append(grid);
  const past = exps.filter((e) => e.type === 'study');
  root.append(panel('Past studies', past.length ? h('table', h('tr', h('th', 'Study'), h('th', 'Status'), h('th', 'Created'), h('th', 'Algorithms')),
    past.map((e) => h('tr.click', { onclick: () => app.go(`studies/${e.id}`) }, h('td', e.name, e.synthetic ? [' ', badge('synthetic data', 'synthetic-data')] : null),
      h('td', statusBadge(e.status)), h('td.dim', fmtDate(e.created)), h('td.small.dim', e.algorithm_version)))) : empty('No studies run yet')));
}

async function view(root, eid, app) {
  const d = await api.get(`/api/experiments/${eid}`);
  const E = d.experiment;
  root.append(pageHead(E.name, `${fmtDate(E.created)} · algorithms ${E.algorithm_version}`, statusBadge(E.status), h('button.ghost', { onclick: () => app.go('studies') }, '‹ Studies'),
    h('button', { onclick: () => app.go(`export/exp/${eid}`) }, 'Export…')));
  if (E.status !== 'complete') return root.append(panel('Did not complete', h('pre.prompt', E.error || E.status)));
  const imgs = d.files.filter((f) => f.endsWith('.png'));
  const url = (f) => `/api/file?${new URLSearchParams({ exp: eid, file: f, t: api.token() })}`;
  root.append(h('div.grid.g-side',
    h('div', d.report ? panel('Findings', md(d.report, url)) : null, d.study_result?.rows ? panel('Results', table(d.study_result.rows)) : null),
    h('div', imgs.map((f) => panel(f.replace(/\.png$/, '').replace(/_/g, ' '), h('img', { src: url(f), style: { width: '100%', background: '#fff', borderRadius: '6px' } }))))));
}

function table(rows) {
  if (!rows.length) return empty('No rows');
  const cols = Object.keys(rows[0]).filter((k) => typeof rows[0][k] !== 'object');
  return h('div', { style: { overflowX: 'auto' } }, h('table', h('tr', cols.map((c) => h('th', c.replace(/_/g, ' ')))),
    rows.map((r) => h('tr', cols.map((c) => h('td.num.small', typeof r[c] === 'number' ? (+r[c].toFixed(3)).toString() : String(r[c])))))));
}
