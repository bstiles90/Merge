// Sound Profiles: what the references teach, built and versioned (never overwritten).
import { api, waitJob } from '../api.js';
import { h, clear, pageHead, panel, badge, statusBadge, empty, fmtDate, groupName, groupColor, modal, field, showError, toast, confirmBox, promptBox, md, select, GROUPS } from '../ui.js';
import { rangeChart, bandChart } from '../charts.js';
import { programView } from '../programviz.js';

export async function render(root, [pid], app) {
  if (pid) return detail(root, pid, app);
  const body = h('div');
  root.append(pageHead('Sound Profiles', 'A profile summarises how sources relate in your references: pairwise loudness balance, tonal and dynamic tendencies. Each build is kept as its own version.',
    h('button', { onclick: () => compareDialog() }, 'Compare two…'),
    h('button.primary', { onclick: () => createDialog(app, {}, load) }, '+ New profile')), body);
  async function load() {
    const { items } = await api.get('/api/profiles');
    const stale = items.filter((p) => p.stale?.length);
    if (!items.length) return clear(body, panel('Profiles', empty('No profiles yet', 'Import at least one reference, then build a profile from it. Three or more references give a more reliable profile.',
      h('button.primary', { onclick: () => createDialog(app, {}, load) }, 'Build a profile'))));
    clear(body, stale.length ? h('div.notice.warn', `${stale.length} profile(s) no longer reflect the current analysis or stem roles. Rebuilding creates a new version; the old one is kept.`,
      h('button', { style: { marginLeft: '8px' }, onclick: async () => { for (const p of stale) await rebuild(p.id, false); toast(`Rebuilding ${stale.length} profile(s)…`); } }, 'Rebuild all')) : null,
      h('div.panel.flat', h('div.pb', h('table',
      h('tr', h('th', 'Profile'), h('th', 'Status'), h('th', 'References'), h('th', 'Contains'), h('th', 'Created'), h('th', 'Algorithms'), h('th', '')),
      items.map((p) => h('tr.click', { onclick: () => p.status === 'complete' && app.go(`profiles/${p.id}`) },
        h('td', h('b', p.name), p.parent_id ? h('div.faint.small', 'derived from an earlier profile') : null,
          p.stale?.length ? h('div.small', { style: { color: 'var(--warn)' } }, p.stale.join('; ')) : null),
        h('td', statusBadge(p.status), p.error ? h('div.small', { style: { color: 'var(--danger)' } }, p.error.split('\n')[0]) : null),
        h('td.num', p.reference_ids.length, p.composition ? h('div.faint.small', `${p.composition.with_stems} with stems · ${p.composition.master_only} master-only`) : null),
        h('td.small', p.composition && !p.composition.source_level ? badge('programme only', 'info') : [p.composition?.program_analysed ? badge('programme', 'info') : null, ' ',
          (p.groups || []).length ? badge('source balance', 'implemented') : null], (p.groups || []).length ? h('div.faint', (p.groups || []).map(groupName).join(', ')) : null),
        h('td.dim', fmtDate(p.created)), h('td.small.dim', p.algorithm_version || ''),
        h('td', p.stale?.length ? h('button.small', { onclick: (e) => { e.stopPropagation(); rebuild(p.id); } }, 'Rebuild') : h('span.faint', '›'))))))));
  }
  window.addEventListener('lab-job', load);
  await load();
  return () => window.removeEventListener('lab-job', load);

  async function compareDialog() {
    const { items } = await api.get('/api/profiles');
    const done = items.filter((p) => p.status === 'complete');
    if (done.length < 2) return toast('Build at least two profiles to compare them.');
    let a = done[1].id, b = done[0].id;
    const out = h('div');
    const run = async () => {
      const r = await api.get(`/api/profiles-compare?a=${a}&b=${b}`);
      clear(out, h('table', h('tr', h('th', 'Pair'), h('th', r.a.name), h('th', r.b.name), h('th', 'Difference')),
        r.rows.map((x) => h('tr', h('td', pairLabel(x.pair)), h('td.num', fmtLU(x.a)), h('td.num', fmtLU(x.b)),
          h('td.num', { style: { color: x.diff != null && Math.abs(x.diff) >= 1 ? 'var(--warn)' : '' } }, x.diff == null ? '–' : `${x.diff > 0 ? '+' : ''}${x.diff.toFixed(1)} LU`)))),
        h('p.faint.small', 'Median co-active loudness difference between the two sources (first minus second). Differences under ~1 LU are within the spread of most references.'));
    };
    const opts = done.map((p) => [p.id, p.name]);
    modal({ title: 'Compare profiles', wide: true, body: h('div.stack', h('div.row', select(opts, a, (v) => { a = v; run(); }), 'vs', select(opts, b, (v) => { b = v; run(); })), out) });
    run();
  }
}

const fmtLU = (v) => (v == null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(1)} LU`);
const pairLabel = (k) => k.split('|').map(groupName).join(' − ');

export async function createDialog(app, { from, name } = {}, onDone) {
  const { items } = await api.get('/api/library/references');
  if (!items.length) { toast('Import a reference first.'); return app.go('references'); }
  const sel = new Set(from ? from.reference_ids : items.filter((r) => r.include !== false).map((r) => r.id));
  const weights = { ...(from?.weights || {}) };
  const nm = h('input', { value: name || (from ? `${from.name} (v2)` : `Profile ${new Date().toLocaleDateString()}`), style: { width: '100%' } });
  const notes = h('textarea', { value: '' });
  modal({ title: from ? 'New version of a profile' : 'Build a Sound Profile', wide: true, body: h('div.stack',
    field('Profile name', nm),
    h('p.dim', 'Choose the references this profile learns from. A new profile is always created; existing profiles are never changed.'),
    h('p.dim.small', 'Master-only references feed the Program Sound Profile (spectrum, loudness, dynamics, transients, stereo). References with stems also feed source-level balance. A profile can mix both.'),
    h('table', h('tr', h('th', ''), h('th', 'Reference'), h('th', 'Material'), h('th', 'Weight'), h('th', 'Check')),
      items.map((r) => h('tr',
        h('td', h('input', { type: 'checkbox', checked: sel.has(r.id), onchange: (e) => (e.target.checked ? sel.add(r.id) : sel.delete(r.id)) })),
        h('td', r.title, r.synthetic ? [' ', badge('synthetic', 'synthetic-data')] : null, r._missing?.length ? [' ', badge('files missing', 'error')] : null),
        h('td.small', (r.stems || []).length ? [...new Set((r.stems || []).map((s) => s.group))].map(groupName).join(', ') : badge('master only', 'info')),
        h('td', h('input', { type: 'number', step: 0.1, min: 0, value: weights[r.id] ?? r.weight ?? 1, onchange: (e) => { weights[r.id] = +e.target.value; } })),
        h('td', r.validation ? badge(r.validation.status === 'ok' ? 'Good' : r.validation.status, r.validation.status === 'ok' ? 'ok' : r.validation.status) : h('span.faint', '–'))))),
    h('p.faint.small', 'Fewer than three references: the profile is usable for research, but its targets are less certain (the report says so).'),
    field('Notes', notes)),
  actions: [{ label: 'Cancel' }, { label: 'Build profile', primary: true, run: async () => {
    if (!sel.size) { toast('Choose at least one reference', true); return false; }
    const r = await api.post('/api/profiles/create', { name: nm.value, reference_ids: [...sel], weights, notes: notes.value, parent_id: from?.id });
    toast('Building the profile…');
    waitJob(r.job).then(() => { onDone && onDone(); }).catch(showError);
    onDone && onDone();
  } }] });
}

function reliabilityPanel(profile) {
  const rows = Object.entries(profile.balance).map(([k, v]) => ({ k, v, r: v.reliability }));
  const has = rows.some((x) => x.r && x.r.nRefs);
  const full = (v) => { const b = v.byDensity || {}; const n = b.all?.n || 0; return n ? Math.round(100 * (b.full?.n || 0) / n) : null; };
  return panel('How firm are these targets?', [
    h('p.dim.small', has ? 'Per pair: the spread of the references’ own medians, and how far the target would move with a different set of songs (bootstrap over references, 80 % interval). Wide intervals mean the songs disagree: more references, or a different grouping, are needed before trusting that target.'
      : 'This profile predates reliability statistics (algorithm 0.5). Rebuild it to see per-pair intervals. Shown: between-reference SD (population) and the share of blocks classed “full”.'),
    h('table', h('tr', h('th', 'Pair'), h('th', 'Target'), has ? h('th', '80 % interval') : null, h('th', 'Ref. medians'), h('th', 'SD'), h('th', '“full”')),
      rows.map(({ k, v, r }) => h('tr', h('td', pairLabel(k)), h('td.num', fmtLU(v.byDensity?.all?.median)),
        has ? h('td.num', { style: { color: r?.targetCI80_width > 3 ? 'var(--warn)' : '' } }, r?.targetCI80 ? `${r.targetCI80[0]} … ${r.targetCI80[1]}` : '–') : null,
        h('td.num.small', r?.refRange_LU ? `${r.refRange_LU[0]} … ${r.refRange_LU[1]}` : '–'),
        h('td.num', (r?.betweenRefSD ?? v.betweenRefSD) ?? '–'), h('td.num.dim', full(v) == null ? '–' : `${full(v)} %`)))),
    h('p.faint.small', 'The older “confidence” number was a heuristic (reference count and spread); it is kept in the file for compatibility but no longer shown.')]);
}

async function rebuild(pid, go = true) {
  try {
    const r = await api.post(`/api/profiles/${pid}/rebuild`, {});
    toast('Rebuilding as a new version — the original profile is kept.');
    if (go) waitJob(r.job).then(() => window.lab.go(`profiles/${r.profile_id}`)).catch(showError);
    return r;
  } catch (e) { showError(e); }
}

async function detail(root, pid, app) {
  const { meta, profile, report } = await api.get(`/api/profiles/${pid}`);
  const tabs = h('div.seg');
  const body = h('div');
  root.append(pageHead(meta.name, `Built ${fmtDate(meta.finished || meta.created)} from ${meta.reference_ids.length} reference(s) · algorithms ${meta.algorithm_version || '?'}`,
    h('button.ghost', { onclick: () => app.go('profiles') }, '‹ All profiles'),
    h('button', { onclick: async () => { const n = await promptBox('Rename profile', 'Name', meta.name); if (n) { await api.post(`/api/profiles/${pid}/rename`, { name: n }); app.route(); } } }, 'Rename'),
    h('button.primary', { title: 'Same references and weights, current stem roles and algorithm. The original is kept.', onclick: () => rebuild(pid) }, 'Rebuild'),
    h('button', { onclick: () => createDialog(app, { from: { ...meta } }, () => app.go('profiles')) }, 'Duplicate / change references…'),
    h('button', { onclick: () => app.go(`export/profile/${pid}`) }, 'Export…'),
    h('button.ghost', { onclick: async () => {
      if (!await confirmBox('Delete profile', 'Delete this profile? Experiments that used it keep their own snapshot of it.', 'Delete', true)) return;
      try { await api.post(`/api/profiles/${pid}/delete`, {}); app.go('profiles'); } catch (e) { showError(e); }
    } }, 'Delete')),
    (profile.groups || []).includes('keys') && !(profile.groups || []).includes('synths') && (!meta.algorithm_version || meta.algorithm_version < '0.5')
      ? h('div.notice.warn', 'Built before Keys and Synths were separate groups: “Keys” in this profile means keys, synths and other together. Review stem roles in the Reference Library, then Rebuild.') : '',
    tabs, h('div', { style: { height: '12px' } }), body);
  const hasSource = (profile.groups || []).length > 0, hasProgram = !!profile.program_profile;
  const T = { ...(hasProgram ? { program: 'Program' } : {}), balance: 'Source balance', tone: 'Source tone', dynamics: 'Source dynamics', refs: 'References & limitations', report: 'Report' };
  let cur = hasSource ? 'balance' : 'program';
  const noStems = () => panel('No stems in this profile', empty('Source-level views need references with stems',
    'This profile was built from stereo masters only. Attach stems to references in the Reference Library, then use “Duplicate / regenerate…” to build a new version that includes them.',
    h('button', { onclick: () => app.go('references') }, 'Reference Library')));
  const show = (k) => { cur = k; clear(tabs, Object.entries(T).map(([id, l]) => h('button' + (id === cur ? '.on' : ''), { onclick: () => show(id) }, l))); clear(body, VIEWS[k]()); };
  const VIEWS = {
    program() {
      const pp = profile.program_profile;
      if (!pp) return panel('Program', empty('No programme analysis', 'Profiles built before programme analysis existed have none. Build a new version to add it.'));
      let sel = pp.references[0]?.id;
      const box = h('div');
      const drawP = () => clear(box, h('div', { style: { display: 'grid', gridTemplateColumns: '240px minmax(0, 1fr)', gap: '14px', alignItems: 'start' } },
        h('div.panel.flat', h('div.ph', h('h2', 'References')), h('div.pb', h('table', pp.references.map((r) => h('tr.click' + (r.id === sel ? '.sel' : ''), { onclick: () => { sel = r.id; drawP(); } },
          h('td', r.title, h('div.faint.small', r.has_stems ? 'stems' : 'master only'))))))),
        programView({ profile: pp, refs: pp.references, selected: sel, onSelect: (id) => { sel = id; drawP(); } })));
      drawP();
      return box;
    },
    balance() {
      if (!hasSource) return noStems();
      const rows = Object.entries(profile.balance).map(([k, v]) => {
        const s = v.byDensity?.all || {};
        return { label: pairLabel(k), ...s, title: `${s.n || 0} blocks · ${v.nRefs} ref(s) · between-reference SD ${v.betweenRefSD ?? '–'} LU` };
      });
      const all = rows.flatMap((r) => [r.p10, r.p90]).filter((x) => x != null);
      const lo = Math.floor(Math.min(-6, ...all) / 3) * 3, hi = Math.ceil(Math.max(6, ...all) / 3) * 3;
      return h('div.grid', { style: { gridTemplateColumns: 'minmax(0,1fr) 340px', gap: '14px' } }, h('div', panel('Pairwise balance targets', [
        h('p.dim.small', 'For each pair of sources playing together: how much louder the first is than the second (short-term loudness, LU). Box = middle half of the time, line = 10–90 %, blue tick = median target.'),
        rangeChart(rows, { lo, hi })]), reliabilityPanel(profile)),
        panel('How this is used', h('div.small.dim.stack',
          h('p', 'During analysis, the operator measures the same pairwise differences in your mix while both sources are active and nudges group faders toward a blend of your own baseline and these targets (reference influence β).'),
          h('p', 'These relationships are unaffected by mastering loudness, so commercial masters can be compared with your stems.'),
          h('p', `Density breakdown: ${Object.keys(Object.values(profile.balance)[0]?.byDensity || {}).join(', ')}.`))));
    },
    tone() {
      if (!hasSource) return noStems();
      return h('div.grid.g3', Object.entries(profile.tonal).map(([g, t]) => panel(groupName(g), [
        bandChart(t.band_centres_hz, [{ values: t.shape_dB.median, color: groupColor(g) }], { lo: -40, hi: 15 }),
        h('p.faint.small', `Spectral shape relative to the group's own level (octave bands). ${t.use}`)])));
    },
    dynamics() {
      if (!hasSource) return noStems();
      return panel('Dynamics tendencies', [h('table', h('tr', h('th', 'Group'), h('th', 'Momentary loudness spread'), h('th', 'Crest factor'), h('th', '')),
        Object.entries(profile.dynamics).map(([g, d]) => h('tr', h('td', groupName(g)), h('td.num', d.momentarySpread_LU?.median == null ? '–' : `${d.momentarySpread_LU.median.toFixed(1)} LU (±${(d.momentarySpread_LU.spread ?? 0).toFixed(1)})`),
          h('td.num', d.crest_dB?.median == null ? '–' : `${d.crest_dB.median.toFixed(1)} dB`), h('td.small.dim', d.includesMastering ? 'includes mastering' : '')))),
        h('h3', 'Programme (mastered references)'),
        h('div.kv', h('span', 'Integrated loudness'), h('span', `${profile.program?.integrated_LUFS} LUFS`), h('span', 'Loudness range'), h('span', `${profile.program.LRA_LU} LU`),
          h('span', 'True peak'), h('span', `${profile.program.truePeak_dBTP} dBTP`), h('span', 'Spectral tilt'), h('span', `${profile.program.tilt_dB_per_oct} dB/oct`)),
        h('p.faint.small', 'Programme values reflect mastering. They are reported for context and never chased with channel levels.')]);
    },
    refs() {
      const pr = profile.program_profile?.references || [];
      const rows = [...profile.references.map((r) => ({ title: r.title, weight: r.weight, dur: r.duration_s, excluded: r.excluded, mat: 'stems' + (pr.find((x) => x.id === r.id) ? ' + programme' : '') })),
        ...pr.filter((r) => !r.has_stems).map((r) => ({ title: r.title, weight: r.weight, dur: r.duration_s, mat: 'master only (programme)' }))];
      return h('div.grid.g2', panel('References used', h('table', h('tr', h('th', 'Reference'), h('th', 'Used for'), h('th', 'Weight'), h('th', 'Length')),
        rows.map((r) => h('tr', h('td', r.title, r.excluded ? [' ', badge('excluded', 'warn')] : null), h('td.small', r.mat), h('td.num', r.weight), h('td.num', `${Math.round(r.dur)} s`))))),
        panel('Limitations', h('div', (meta.limitations || []).map((l) => h('div.finding.warn', h('span.i', '!'), h('span', l))),
          (profile.notes || []).map((n) => h('div.finding', h('span.i', 'i'), h('span', n))))));
    },
    report() { return panel('Profile report', report ? md(report) : empty('No report')); },
  };
  show(cur);
}
