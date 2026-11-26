// Experiment History: every run is kept; filter, rerun, compare across algorithm versions, archive.
import { api } from '../api.js';
import { h, clear, pageHead, panel, badge, statusBadge, empty, fmtDate, select, showError, toast, confirmBox, fmtBytes } from '../ui.js';

export async function render(root, [sub, a, b], app) {
  if (sub === 'compare') return compareView(root, a, b, app);
  const { items } = await api.get('/api/experiments');
  const f = { type: '', status: '', version: '', archived: false, q: '' };
  const chosen = new Set();
  const body = h('div');
  const versions = [...new Set(items.map((e) => e.algorithm_version).filter(Boolean))];
  root.append(pageHead('Experiment History', 'Every run is saved with its exact settings, inputs and algorithm version. Nothing is overwritten: reruns and new settings create new experiments.',
    h('button', { onclick: () => { if (chosen.size !== 2) return toast('Tick exactly two experiments to compare.'); const [x, y] = [...chosen]; app.go(`history/compare/${x}/${y}`); } }, 'Compare selected'),
    h('button', { onclick: () => { if (!chosen.size) return toast('Tick experiments to export.'); app.go(`export/exp/${[...chosen].join(',')}`); } }, 'Export selected')),
    h('div.row', { style: { marginBottom: '10px' } },
      h('input', { placeholder: 'Search names…', oninput: (e) => { f.q = e.target.value.toLowerCase(); draw(); } }),
      select([['', 'All types'], ['music', 'Music'], ['speech', 'Speech'], ['program', 'Broadcast compare'], ['study', 'Studies']], '', (v) => { f.type = v; draw(); }),
      select([['', 'Any status'], ['complete', 'Complete'], ['failed', 'Failed'], ['cancelled', 'Cancelled'], ['interrupted', 'Interrupted'], ['running', 'Running']], '', (v) => { f.status = v; draw(); }),
      select([['', 'Any algorithm version'], ...versions.map((v) => [v, v])], '', (v) => { f.version = v; draw(); }),
      h('label.row.tight', h('input', { type: 'checkbox', onchange: (e) => { f.archived = e.target.checked; draw(); } }), 'Show archived')), body);
  function draw() {
    const rows = items.filter((e) => (!f.type || e.type === f.type) && (!f.status || e.status === f.status) && (!f.version || e.algorithm_version === f.version)
      && (f.archived || !e.archived) && (!f.q || (e.name || '').toLowerCase().includes(f.q)));
    if (!rows.length) return clear(body, panel('Experiments', empty('No experiments match')));
    clear(body, h('div.panel.flat', h('div.pb', h('table',
      h('tr', h('th', ''), h('th', 'Experiment'), h('th', 'Type'), h('th', 'Status'), h('th', 'Input / profile'), h('th', 'Algorithms'), h('th', 'Created'), h('th', '')),
      rows.map((e) => h('tr',
        h('td', h('input', { type: 'checkbox', checked: chosen.has(e.id), onchange: (ev) => (ev.target.checked ? chosen.add(e.id) : chosen.delete(e.id)) })),
        h('td', h('a', { href: '#/' + app.expRoute(e) }, e.name), e.archived ? [' ', badge('archived', 'info')] : null,
          e.synthetic ? [' ', badge('synthetic data', 'synthetic-data')] : null, e.parent_id ? h('div.faint.small', `rerun of ${e.parent_id}`) : null),
        h('td', e.type === 'study' ? `study · ${e.study}` : e.type === 'program' ? 'broadcast compare' : e.type), h('td', statusBadge(e.status)),
        h('td.small', e.inputs?.item_name || '', e.inputs?.profile_name ? h('div.faint', e.inputs.profile_name) : null),
        h('td.small.mono', e.algorithm_version || ''), h('td.small.dim', fmtDate(e.created)),
        h('td', h('div.row.tight',
          h('button.ghost', { onclick: async () => { try { await api.post(`/api/experiments/${e.id}/rerun`, {}); toast('Rerun started'); app.route(); } catch (x) { showError(x); } } }, 'Rerun'),
          ['music', 'speech'].includes(e.type) ? h('button.ghost', { title: 'Open the lab with these settings', onclick: () => app.go(e.type === 'music' ? `music/${e.inputs.mix_id}` : `speech/${e.inputs.speech_id}`) }, 'Duplicate…') : null,
          h('button.ghost', { onclick: async () => { await api.post(`/api/experiments/${e.id}/${e.archived ? 'unarchive' : 'archive'}`); e.archived = !e.archived; draw(); } }, e.archived ? 'Unarchive' : 'Archive'),
          h('button.ghost', { onclick: async () => {
            if (!await confirmBox('Delete experiment', `Permanently delete “${e.name}” and all feedback on it?`, 'Delete', true)) return;
            await api.post(`/api/experiments/${e.id}/delete`, { confirm: true }); items.splice(items.indexOf(e), 1); draw();
          } }, 'Delete')))))))));
  }
  draw();
  const onJob = () => app.route();
  window.addEventListener('lab-job', onJob);
  return () => window.removeEventListener('lab-job', onJob);
}

async function compareView(root, a, b, app) {
  const { items } = await api.get('/api/experiments');
  const ok = items.filter((e) => e.status === 'complete' && e.type !== 'study');  // music, speech and broadcast comparisons
  if (!a) a = ok[1]?.id;
  if (!b || !ok.find((e) => e.id === b)) b = ok.find((e) => e.id !== a)?.id;
  const body = h('div');
  const opts = ok.map((e) => [e.id, `${e.name} · ${e.algorithm_version} · ${fmtDate(e.created)}`]);
  root.append(pageHead('Compare experiments', 'Side by side measurements of two runs — typically the same material with different settings, profiles or algorithm versions.', h('button.ghost', { onclick: () => app.go('history') }, '‹ History')),
    h('div.row', { style: { marginBottom: '12px' } }, select(opts, a, (v) => { a = v; run(); }), h('span', 'vs'), select(opts, b, (v) => { b = v; run(); })), body);
  async function run() {
    if (!a || !b) return clear(body, empty('Two completed experiments are needed'));
    try {
      const r = await api.get(`/api/experiments-compare?a=${a}&b=${b}`);
      clear(body,
        r.notes?.length ? r.notes.map((n) => h('div.notice.warn', n)) : null,
        h('div.panel.flat', h('div.pb', h('table', h('tr', h('th', 'Measure'), h('th', r.a.name), h('th', r.b.name), h('th', 'Change')),
          r.rows.map((x) => h('tr', h('td', LABELS[x.metric] || x.metric.replace(/_/g, ' ')), h('td.num', fmt(x.a)), h('td.num', fmt(x.b)),
            h('td', x.change === 'improved' ? badge('better', 'ok') : x.change === 'regressed' ? badge('worse', 'error') : x.change === 'unchanged' ? badge('same', 'info') : h('span.faint', x.change || '–'))))))),
        h('p.faint.small', r.note || ''),
        h('div.grid.g2', [r.a, r.b].map((x) => panel(`Feedback — ${x.name}`, h('pre.prompt', JSON.stringify({ feedback: x.feedback, blind: x.blind }, null, 1))))),
        h('div.row', h('a', { href: '#/' + app.expRoute(ok.find((e) => e.id === a) || { id: a }) }, 'Open the first'), h('a', { href: '#/' + app.expRoute(ok.find((e) => e.id === b) || { id: b }) }, 'Open the second')));
    } catch (e) { showError(e); }
  }
  run();
}
const LABELS = { pairs_outside: 'Pairs outside the profile band', direction_reversals: 'Direction reversals', response_outside_rms_dB: 'Movement outside disturbances (dB RMS)',
  injection_other_max_dB: 'Largest side effect on other groups (dB)', total_movement_dB: 'Total fader movement (dB)', injection_corrected_mean: 'Disturbances corrected (fraction)',
  idle_noise_reduction_dB: 'Idle-noise reduction (dB)', findings: 'Diagnostic findings', metrics_outside: 'Measures outside every reference', metrics_edge: 'Measures at the edge', profile_references: 'References in the profile', algorithm_version: 'Algorithm version', profile: 'Profile', beta: 'Reference influence β' };
const fmt = (v) => (v == null ? '–' : typeof v === 'number' ? (+v.toFixed(2)).toString() : typeof v === 'object' ? JSON.stringify(v) : String(v));
