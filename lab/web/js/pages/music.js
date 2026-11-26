// Music Lab: your own group stems, analysed against a Sound Profile by the experimental operator.
import { api, waitJob } from '../api.js';
import { h, clear, pageHead, panel, badge, empty, fmtTime, groupName, groupColor, field, help, select, showError, toast, confirmBox, GROUPS, fmtDate } from '../ui.js';
import { openImporter, editDetails, relinkFile } from '../importer.js';
import { TimeCanvas, drawPeaks } from '../charts.js';

export const MUSIC_DEFAULTS = { beta: 0.5, evidence_s: 6, rate_db_s: 0.5, max_boost_db: 4, max_cut_db: 4, exclude_groups: [], render_experimental: false, render_groups: true };

export async function render(root, [mixId], app) {
  const [{ items: mixes }, { items: profiles }] = await Promise.all([api.get('/api/library/mixes'), api.get('/api/profiles')]);
  const done = profiles.filter((p) => p.status === 'complete' && (p.groups || []).length);  // source-level profiles only
  root.append(pageHead('Music Lab', 'Analyse a mix of your own stems against a Sound Profile. The operator proposes group fader offsets; you hear the original and the adjusted version side by side.',
    h('button.primary', { onclick: () => openImporter('mix', { onDone: (it) => app.go(`music/${it.id}`) }) }, '+ Import mix stems')));
  if (!mixes.length) {
    root.append(panel('Comparison mixes', empty('No mixes yet', 'Import group stems exported from a service recording or your DAW: vocals, drums, bass, guitars, keys — all the same length.',
      h('button.primary', { onclick: () => openImporter('mix', { onDone: (it) => app.go(`music/${it.id}`) }) }, 'Import mix stems'))));
    return;
  }
  const mix = mixes.find((m) => m.id === mixId) || mixes[0];
  const list = h('div.panel.flat', h('div.ph', h('h2', 'Comparison mixes')), h('div.pb', h('table',
    mixes.map((m) => h('tr.click' + (m.id === mix.id ? '.sel' : ''), { onclick: () => app.go(`music/${m.id}`) },
      h('td', h('b', m.name), m.synthetic ? [' ', badge('synthetic', 'synthetic-data')] : null, m._missing?.length ? [' ', badge('files missing', 'error')] : null,
        h('div.faint.small', `${(m.stems || []).length} stems${m.raw?.length ? ` · ${m.raw.length} raw` : ''}${m.mix ? ' · stereo mix' : ''} · ${fmtTime(m.stems?.[0]?.file.duration_s)}`)))))));
  const main = h('div');
  root.append(h('div', { style: { display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr)', gap: '14px' } }, list, main));
  experimentForm(main, mix, done, app);
}

function experimentForm(root, mix, profiles, app) {
  const groups = [...new Set((mix.stems || []).map((s) => s.group))];
  const cfg = { ...MUSIC_DEFAULTS, baseline: mix.baseline || [[0, Math.min(30, (mix.stems?.[0]?.file.duration_s || 60) / 3)]], activity: {} };
  let profileId = profiles[0]?.id;
  let injections = (mix.suggested_injections || []).map((x) => ({ ...x }));
  const name = h('input', { value: `${mix.name} — ${new Date().toLocaleDateString()}`, style: { width: '100%' } });
  const dur = mix.stems?.[0]?.file.duration_s || 60;

  // ---------------- waveform with baseline selection
  const lanes = h('div.stack');
  const regionsInfo = h('div.small.dim');
  const canvases = [];
  const regions = () => cfg.baseline === 'all' ? [{ a: 0, b: dur, color: 'rgba(63,154,86,0.13)', label: 'baseline' }]
    : [...cfg.baseline.map(([a, b]) => ({ a, b, color: 'rgba(63,154,86,0.16)', label: 'baseline' })),
      ...injections.map((j) => ({ a: j.start, b: j.end, color: 'rgba(229,72,77,0.10)' }))];
  const redraw = () => {
    for (const c of canvases) { c.regions = regions(); c.render(); }
    clear(regionsInfo, cfg.baseline === 'all' ? 'Baseline: the whole song (your mix as it is)' :
      ['Baseline: ', cfg.baseline.map(([a, b], i) => h('span.badge.b-ok', { style: { marginRight: '4px' } }, `${fmtTime(a)}–${fmtTime(b)}`,
        h('a', { href: '#', style: { marginLeft: '4px', color: 'inherit' }, onclick: (e) => { e.preventDefault(); cfg.baseline.splice(i, 1); if (!cfg.baseline.length) cfg.baseline = 'all'; redraw(); } }, '✕')))]);
  };
  (mix.stems || []).forEach((s) => {
    const tc = new TimeCanvas({ height: 34, duration: dur, regions: regions(),
      onSelect: (sel) => { if (cfg.baseline === 'all') cfg.baseline = []; cfg.baseline.push([+sel[0].toFixed(1), +sel[1].toFixed(1)]); for (const c of canvases) c.sel = null; redraw(); },
      onSeek: () => {} });
    canvases.push(tc);
    lanes.append(h('div', { style: { display: 'grid', gridTemplateColumns: '90px 1fr', alignItems: 'center', gap: '8px' } },
      h('div.small', h('span.dot', { style: { background: groupColor(s.group), marginRight: '6px' } }), groupName(s.group)), tc.el));
    api.get(`/api/peaks?${new URLSearchParams({ path: s.file.path, n: 1500, t: api.token() })}`).then((p) => { tc.drawFn = drawPeaks(p, groupColor(s.group) + '99'); tc.render(); }).catch(() => {});
  });

  // ---------------- settings
  const num = (k, attrs) => h('input', { type: 'number', value: cfg[k], ...attrs, onchange: (e) => { cfg[k] = +e.target.value; } });
  const betaOut = h('span.num', cfg.beta.toFixed(2));
  const betaIn = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: cfg.beta, oninput: (e) => { cfg.beta = +e.target.value; betaOut.textContent = cfg.beta.toFixed(2); } });
  const excl = h('div.row', groups.map((g) => h('label.row.tight', h('input', { type: 'checkbox', onchange: (e) => {
    cfg.exclude_groups = e.target.checked ? [...cfg.exclude_groups, g] : cfg.exclude_groups.filter((x) => x !== g); } }), groupName(g))));
  const actTable = h('table', h('tr', h('th', 'Group'), h('th', ['Threshold ', help('How far below the group’s loud moments it still counts as playing (LU). Closer to 0 = only loud passages count.')]),
    h('th', ['Above noise floor ', help('How far above its own idle floor (bleed, hiss) a group must be to count as playing (LU).')]), h('th', ['Hold ', help('How long a group still counts as playing after it goes quiet (seconds).')])),
    groups.map((g) => {
      const D = { vocals: [-25, 10, 1.5], drums: [-30, 8, 2], bass: [-30, 8, 2], guitars: [-30, 8, 1.5], keys: [-30, 8, 2] }[g] || [-28, 8, 1.5];
      const set = (k, v) => { cfg.activity[g] = { ...(cfg.activity[g] || {}), [k]: v }; };
      return h('tr', h('td', groupName(g)),
        h('td', h('input', { type: 'number', step: 1, value: D[0], onchange: (e) => set('rel_lu', +e.target.value) })),
        h('td', h('input', { type: 'number', step: 1, value: D[1], onchange: (e) => set('margin_lu', +e.target.value) })),
        h('td', h('input', { type: 'number', step: 0.1, value: D[2], onchange: (e) => set('off_s', +e.target.value) })));
    }));
  const advanced = h('details', h('summary', { style: { cursor: 'pointer', color: 'var(--text-secondary)' } }, 'Activity detection (advanced)'),
    h('p.dim.small', 'The operator only compares two groups while both are playing. If a group is wrongly treated as silent or playing, adjust it here.'), actTable);

  // ---------------- disturbances
  const injBox = h('div');
  const drawInj = () => {
    clear(injBox,
      injections.length ? h('table', h('tr', h('th', 'Group'), h('th', 'Change'), h('th', 'From'), h('th', 'To'), h('th', '')),
        injections.map((j, i) => h('tr',
          h('td', select(groups.map((g) => [g, groupName(g)]), j.group, (v) => { j.group = v; })),
          h('td', h('input', { type: 'number', step: 0.5, value: j.db, onchange: (e) => { j.db = +e.target.value; } }), ' dB'),
          h('td', h('input', { type: 'number', step: 1, value: j.start, onchange: (e) => { j.start = +e.target.value; redraw(); } }), ' s'),
          h('td', h('input', { type: 'number', step: 1, value: j.end, onchange: (e) => { j.end = +e.target.value; redraw(); } }), ' s'),
          h('td', h('button.ghost', { onclick: () => { injections.splice(i, 1); drawInj(); redraw(); } }, '✕')))))
        : h('p.dim.small', 'None. The mix is analysed as supplied.'),
      h('button', { onclick: () => { injections.push({ group: groups.includes('guitars') ? 'guitars' : groups[0], db: 3, start: Math.round(dur * 0.25), end: Math.round(dur * 0.45) }); drawInj(); redraw(); } }, '+ Add a known disturbance'));
  };
  drawInj();

  const status = h('div');
  async function run() {
    if (!profileId) return toast('Build a Sound Profile first.', true);
    const config = { ...cfg, activity: Object.keys(cfg.activity).length ? cfg.activity : undefined };
    try {
      const r = await api.post('/api/experiments/music', { name: name.value, inputs: { mix_id: mix.id, profile_id: profileId }, config, injections });
      progress(status, r, app);
    } catch (e) { showError(e); }
  }

  root.append(
    h('div.panel', h('div.ph', h('h2', mix.name), mix.synthetic ? badge('synthetic data', 'synthetic-data') : null, h('div.grow'),
      h('button.ghost', { onclick: () => editDetails('mix', mix, () => app.route()) }, 'Edit'),
      h('button.ghost', { onclick: async () => {
        if (!await confirmBox('Remove mix', 'Remove this mix from the library? Experiments made with it are kept. Your original files are not touched.', 'Remove', true)) return;
        await api.post('/api/library/mixes/remove', { id: mix.id, delete_copied: true }); await app.refresh(); app.go('music');
      } }, 'Remove')),
      h('div.pb.stack',
        mix._missing?.length ? h('div.notice.warn', `Missing files: ${mix._missing.join(', ')}. Relink them before analysing.`,
          (mix.stems || []).filter((s) => mix._missing.includes(s.file.name)).map((s) => h('button', { style: { marginLeft: '8px' }, onclick: () => relinkFile('mixes', mix, s.file, () => app.route()) }, `Relink ${s.file.name}…`))) : null,
        mix.notes ? h('p.dim', mix.notes) : null,
        h('h3', 'Baseline — where your mix already sounds right'),
        h('p.dim.small', 'Drag across the waveforms to mark passages you are happy with. The operator anchors tone and balance to these passages and blends toward the profile from there. Without a selection the whole song is the baseline.'),
        lanes, h('div.row', regionsInfo, h('div', { style: { flex: 1 } }), h('button.ghost', { onclick: () => { cfg.baseline = 'all'; redraw(); } }, 'Use the whole song')))),
    h('div.grid.g2',
      panel('Operator settings', h('div.stack',
        field('Sound Profile', profiles.length ? select(profiles.map((p) => [p.id, p.name]), profileId, (v) => { profileId = v; })
          : h('div', h('span.dim', 'No profile with stems yet (balance control needs references with stems). '), h('a', { href: '#/profiles' }, 'Sound Profiles'))),
        field('Reference influence (β)', h('div.row', betaIn, betaOut), '0 = keep your own baseline balance; 1 = move fully to the profile’s targets. 0.5 blends both.'),
        h('div.form',
          field('Evidence window', h('span', num('evidence_s', { step: 1, min: 2, max: 30 }), ' s'), 'How much recent music the operator needs before judging a balance. Longer = calmer, slower to react.'),
          field('Correction speed', h('span', num('rate_db_s', { step: 0.1, min: 0.1, max: 3 }), ' dB/s'), 'The fastest a fader offset may move.'),
          field('Maximum boost', h('span', num('max_boost_db', { step: 0.5, min: 0, max: 12 }), ' dB'), 'Largest increase the operator may apply to a group.'),
          field('Maximum cut', h('span', num('max_cut_db', { step: 0.5, min: 0, max: 12 }), ' dB'), 'Largest decrease the operator may apply to a group.')),
        field('Exclude from adjustment', excl, 'Excluded groups are still measured and still heard, but never moved.'),
        advanced)),
      panel('Rendering & testing', h('div.stack',
        h('label.row', h('input', { type: 'checkbox', checked: cfg.render_groups, onchange: (e) => { cfg.render_groups = e.target.checked; } }),
          h('span', 'Render each group separately (for solo/mute audition in the Listening Room)')),
        h('label.row', h('input', { type: 'checkbox', checked: cfg.render_experimental, onchange: (e) => { cfg.render_experimental = e.target.checked; } }),
          h('span', 'Also render experimental EQ recommendations '), badge('experimental', 'experimental')),
        h('h3', ['Known disturbances ', help('Deliberately change a group’s level for a while (e.g. guitars +3 dB from 0:20 to 0:40). The adjusted result is then scored against an undisturbed run: how much of the change did the operator undo, and what else did it touch?')]),
        injBox))),
    h('div.panel', h('div.pb.row', field('Experiment name', name), h('div', { style: { flex: 1 } }),
      h('button.primary.big', { onclick: run, disabled: !profiles.length || mix._missing?.length }, 'Analyse & render')), status));
  redraw();
}

export function progress(box, r, app) {
  const bar = h('div.bar', { style: { width: '100%', height: '6px', background: 'var(--surface-well)', borderRadius: '3px', overflow: 'hidden' } }, h('i', { style: { display: 'block', height: '100%', width: '0%', background: 'var(--accent)' } }));
  const txt = h('div.dim.small', 'Queued…');
  const cancel = h('button', { onclick: () => api.post(`/api/jobs/${r.job}/cancel`) }, 'Cancel');
  clear(box, h('div.pb.stack', h('div.row', h('b', 'Working'), h('div', { style: { flex: 1 } }), cancel), bar, txt));
  waitJob(r.job, (j) => { bar.firstChild.style.width = `${Math.round((j.fraction || 0) * 100)}%`; txt.textContent = `${j.stage || j.status}${j.text ? ' — ' + j.text : ''} · ${Math.round(j.elapsed_s)} s`; })
    .then(() => { toast('Analysis complete'); app.go(`listen/${r.exp_id}`); })
    .catch((e) => { clear(box, h('div.pb', h('div.finding.error', h('span.i', '✕'), h('span', e.message === 'Cancelled' ? 'Cancelled. Nothing was saved except a record that this run was cancelled.' : e.message.split('\n').slice(-3).join(' '))))); });
}
