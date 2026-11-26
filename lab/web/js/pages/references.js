// Reference Library: recordings whose sound you want Merge to learn from. Start with stereo
// masters alone (programme analysis); attach stems later for source-level intelligence.
import { api, waitJob, currentJobs } from '../api.js';
import { h, clear, pageHead, panel, badge, empty, fmtTime, groupName, confirmBox, showError, toast, modal, fmtDate, field, select, GROUPS,
  pickAudio, pickFolder, setDropHandler, seg } from '../ui.js';
import { openImporter, editDetails, relinkFile } from '../importer.js';
import { quickPlayer } from '../quickplay.js';
import { programView } from '../programviz.js';

let TAB = 'library';

export async function render(root, [tab, selId], app) {
  if (tab) TAB = tab;
  const body = h('div');
  const tabs = h('div');
  root.append(pageHead('Reference Library', 'Recordings with the sound you want. Stereo masters alone are enough to start: each is analysed for spectrum, loudness, dynamics, transients and stereo image. Attach stems later to add source-level balance.',
    h('button', { onclick: () => openImporter('reference', { onDone: load }) }, '+ Import with stems'),
    h('button.primary', { onclick: () => batchImport(load) }, '+ Import masters')), tabs, h('div', { style: { height: '12px' } }), body);
  let items = [], overview = null, sel = selId || null, suggestions = [];

  async function load() {
    [items, overview, suggestions] = await Promise.all([api.get('/api/library/references').then((r) => r.items), api.get('/api/references/program-overview'),
      api.get('/api/library/references/role-suggestions').then((r) => r.items)]);
    draw();
  }
  function draw() {
    clear(tabs, seg([['library', `Library (${items.length})`], ['overview', 'Program overview']], TAB, (v) => { TAB = v; draw(); }));
    if (!items.length) return clear(body, panel('References', empty('No references yet',
      'Start with mastered stereo songs you like — you can import a whole folder at once. Stems are optional and can be attached later.',
      h('button.primary', { onclick: () => batchImport(load) }, 'Import masters'), h('button', { onclick: () => openImporter('reference', { onDone: load }) }, 'Import a song with stems'))));
    clear(body, TAB === 'overview' ? overviewView() : libraryView());
  }

  // ---------------------------------------------------------------- library table
  function libraryView() {
    const running = currentJobs().some((j) => j.kind === 'analyse_refs' && (j.status === 'running' || j.status === 'queued'));
    const stale = overview.references.filter((r) => r.stale).length;
    const missing = items.filter((r) => r.master && !overview.references.find((o) => o.id === r.id)?.analysed).length;
    return h('div',
      suggestions.length ? h('div.notice', `${suggestions.length} stem(s) look like they belong to a different group with the current six-group layout (for example Synths filed under the old Keys & Other). `,
        h('button', { style: { marginLeft: '8px' }, onclick: reviewRoles }, 'Review roles…')) : null,
      stale || missing ? h('div.notice.warn', `${missing ? `${missing} master(s) not analysed yet. ` : ''}${stale ? `${stale} analysed with an older algorithm version. ` : ''}`,
        h('button', { style: { marginLeft: '8px' }, disabled: running, onclick: () => analyse(null, !!stale) }, running ? 'Analysing…' : 'Analyse now')) : null,
      h('div.panel.flat', h('div.pb', h('table',
        h('tr', h('th', 'Song'), h('th', 'Material'), h('th', 'Programme'), h('th', 'Length'), h('th', 'Check'), h('th', 'Weight'), h('th', 'In profiles'), h('th', '')),
        items.map((it) => row(it, running))))));
  }
  function row(it, running) {
    const v = it.validation, P = it.program, o = overview.references.find((x) => x.id === it.id);
    const groups = [...new Set((it.stems || []).map((s) => s.group))];
    const ps = P?.summary || {};
    const prog = !it.master ? h('span.faint', 'no master')
      : o?.analysed ? h('div', badge(o.stale ? 're-analyse' : 'analysed', o.stale ? 'warn' : 'ok'),
        h('div.small.dim.num', `${ps['loudness.integrated_LUFS'] ?? '–'} LUFS · LRA ${ps['loudness.LRA_LU'] ?? '–'} · tilt ${ps['spectrum.tilt_dB_per_oct'] ?? '–'}`))
        : P?.status === 'failed' ? h('span', { title: P.error }, badge('analysis failed', 'error'))
          : badge(running ? 'analysing…' : 'not analysed', running ? 'running' : 'info');
    return h('tr',
      h('td', h('b', it.title || '(untitled)'), it.synthetic ? [' ', badge('synthetic', 'synthetic-data')] : null,
        h('div.dim.small', [it.artist, it.album, it.version].filter(Boolean).join(' · ') || ''),
        it._missing && it._missing.length ? h('div', badge(`${it._missing.length} file(s) missing`, 'error')) : null),
      h('td.small', groups.length ? [badge('stems', 'implemented'), h('div.faint', groups.map(groupName).join(', '))] : badge('master only', 'info')),
      h('td', prog),
      h('td.num', fmtTime((it.master || it.stems?.[0]?.file || {}).duration_s)),
      h('td', v ? badge(v.status === 'ok' ? 'Good' : v.status === 'warn' ? 'Warnings' : 'Problems', v.status === 'ok' ? 'ok' : v.status === 'warn' ? 'warn' : 'error') : h('span.faint', '–'),
        v && v.reconstruction_error_dB != null ? h('div.faint.small', `recon ${v.reconstruction_error_dB.toFixed(1)} dB`) : null),
      h('td.num', (it.weight ?? 1).toFixed(1)),
      h('td', it.include === false ? h('span.dim', 'excluded') : '✓'),
      h('td', h('div.row.tight',
        it.master ? h('button.ghost', { title: 'Play the master', onclick: () => quickPlayer(it.title, { path: it.master.path }) }, '▶') : null,
        o?.analysed ? h('button.ghost', { title: 'Compare with the other references', onclick: () => { sel = it.id; TAB = 'overview'; draw(); } }, 'Overview') : null,
        h('button.ghost', { title: groups.length ? 'Replace the stems' : 'Add stems for source-level analysis', onclick: () => openImporter('reference', { attachTo: it, onDone: load }) }, groups.length ? 'Stems…' : 'Attach stems…'),
        groups.length ? h('button.ghost', { title: 'Change which group each stem belongs to (no reimport)', onclick: () => editRoles(it) }, 'Roles…') : null,
        h('button.ghost', { onclick: () => showItem(it) }, 'Details'),
        h('button.ghost', { onclick: () => editDetails('reference', it, load) }, 'Edit'),
        h('button.ghost', { onclick: () => remove(it) }, 'Remove'))));
  }

  // ---------------------------------------------------------------- program overview
  function overviewView() {
    const analysed = overview.references.filter((r) => r.analysed);
    if (!overview.aggregate) return panel('Program overview', empty('No analysed masters yet', 'Import masters; each is analysed automatically.'));
    if (!sel || !analysed.find((r) => r.id === sel)) sel = analysed[0].id;
    const list = h('div.panel.flat', { style: { position: 'sticky', top: 0 } }, h('div.ph', h('h2', 'References'), h('div.grow'), h('span.small.dim', `${overview.aggregate.n_references} in aggregate`)),
      h('div.pb.scroll-y', { style: { maxHeight: 'calc(100vh - 230px)' } }, h('table', analysed.map((r) => h('tr.click' + (r.id === sel ? '.sel' : ''), { onclick: () => { sel = r.id; draw(); } },
        h('td', h('div', r.title || '(untitled)'), h('div.faint.small', [r.artist, r.has_stems ? 'stems' : 'master only', r.include === false ? 'excluded from profiles' : ''].filter(Boolean).join(' · ')),
          r.stale ? badge('re-analyse', 'warn') : null))))));
    const cur = analysed.find((r) => r.id === sel);
    return h('div', { style: { display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr)', gap: '14px', alignItems: 'start' } }, list,
      h('div', h('div.notice', 'The aggregate covers every analysed reference marked “use in new profiles”. A Sound Profile freezes these statistics when it is built; this view always reflects the current library.'),
        programView({ profile: overview.aggregate, refs: analysed.filter((r) => r.include !== false), selected: cur, selectedLabel: cur.title, onSelect: (id) => { sel = id; draw(); } })));
  }

  // ---------------------------------------------------------------- stem roles (no reimport)
  function rolesNote() { return h('p.dim.small', 'Changing roles never touches your audio. Existing Sound Profiles keep their results; rebuild them (Sound Profiles → Rebuild) to use the new roles.'); }
  async function applyRoles(changes) {
    if (!changes.length) return;
    await api.post('/api/library/references/regroup', { changes });
    toast(`${changes.length} stem role(s) changed. Rebuild your profiles to use them.`);
    await load();
  }
  function editRoles(it) {
    const st = {};
    (it.stems || []).forEach((e) => { st[e.file.id] = e.group; });
    modal({ title: `Stem roles — ${it.title}`, wide: true, body: h('div.stack', rolesNote(),
      h('table', h('tr', h('th', 'Stem file'), h('th', 'Group')), (it.stems || []).map((e) => h('tr', h('td', e.file.name),
        h('td', select(GROUPS.map((g) => [g, groupName(g)]), e.group, (v) => { st[e.file.id] = v; })))))),
    actions: [{ label: 'Cancel' }, { label: 'Save roles', primary: true, run: () => applyRoles((it.stems || []).filter((e) => st[e.file.id] !== e.group)
      .map((e) => ({ ref_id: it.id, file_id: e.file.id, group: st[e.file.id] }))) }] });
  }
  function reviewRoles() {
    const pick = new Set(suggestions.map((_, i) => i));
    modal({ title: 'Review stem roles', wide: true, body: h('div.stack',
      h('p', 'Since this version, Keys (piano, organ, Rhodes) and Synths (synths, pads, atmospheres, strings, “other”) are separate groups. These stems were matched to a different group from their file names. Untick any that are wrong.'),
      rolesNote(),
      h('table', h('tr', h('th', ''), h('th', 'Reference'), h('th', 'Stem file'), h('th', 'Now'), h('th', 'Suggested')),
        suggestions.map((s, i) => h('tr', h('td', h('input', { type: 'checkbox', checked: true, onchange: (e) => (e.target.checked ? pick.add(i) : pick.delete(i)) })),
          h('td', s.reference), h('td', s.file), h('td', groupName(s.current)), h('td', h('b', groupName(s.suggested))))))),
    actions: [{ label: 'Cancel' }, { label: 'Apply selected', primary: true, run: () => applyRoles(suggestions.filter((_, i) => pick.has(i)).map((s) => ({ ref_id: s.ref_id, file_id: s.file_id, group: s.suggested }))) }] });
  }

  // ---------------------------------------------------------------- actions
  async function analyse(ids, force) {
    try { const r = await api.post('/api/references/analyse', { ids, force }); toast('Analysing masters…'); draw(); await waitJob(r.job); await load(); } catch (e) { showError(e); }
  }
  function showItem(it) {
    const files = [it.master ? { f: it.master, role: 'Master' } : null, ...(it.stems || []).map((s) => ({ f: s.file, role: groupName(s.group) + ' stem' }))].filter(Boolean);
    const P = it.program;
    const m = modal({ title: it.title || 'Reference', wide: true, body: h('div.stack',
      h('div.kv', h('span', 'Artist'), h('span', it.artist || '–'), h('span', 'Album'), h('span', it.album || '–'), h('span', 'Category'), h('span', it.category),
        h('span', 'Imported'), h('span', fmtDate(it.created)), h('span', 'Stems attached'), h('span', it.stems?.length ? fmtDate(it.stems_attached || it.created) : 'no'),
        h('span', 'Programme analysis'), h('span', P?.status === 'analysed' ? `${fmtDate(P.analysed)} · algorithms ${P.algorithm_version}` : P?.status || 'not yet'),
        h('span', 'Notes'), h('span', it.notes || '–')),
      P?.warnings?.length ? P.warnings.map((w) => h('div.finding.warn', h('span.i', '!'), h('span', w))) : null,
      h('h3', 'Files'),
      h('table', h('tr', h('th', 'Role'), h('th', 'File'), h('th', 'Stored'), h('th', '')),
        files.map(({ f, role }) => h('tr', h('td', role), h('td', f.name, h('div.faint.small', f.path)), h('td.small', f.stored === 'workspace' ? 'copied into workspace' : 'referenced'),
          h('td', (it._missing || []).includes(f.name) ? h('button', { onclick: () => relinkFile('references', it, f, () => { m.close(); load(); }) }, 'Relink…') : null)))),
      it.validation ? [h('h3', 'Check results'), it.validation.findings.map((x) => h('div.finding.' + x.level, h('span.i', x.level === 'ok' ? '✓' : x.level === 'error' ? '✕' : x.level === 'warn' ? '!' : 'i'), h('span', x.text)))] : null),
    actions: [{ label: 'Re-analyse master', run: () => analyse([it.id], true) }, { label: 'Close' }] });
  }
  async function remove(it) {
    const copied = [it.master, ...(it.stems || []).map((s) => s.file)].filter((f) => f && f.stored === 'workspace').length;
    if (!await confirmBox('Remove reference', `Remove “${it.title}” from the library? Existing profiles keep their measurements. ${copied ? `${copied} copied file(s) inside the workspace will be deleted. ` : ''}Your original files are not touched.`, 'Remove', true)) return;
    try { await api.post('/api/library/references/remove', { id: it.id, delete_copied: true }); toast('Removed'); await app.refresh(); load(); } catch (e) { showError(e); }
  }
  const onJob = (e) => { if (['analyse_refs', 'validate'].includes(e.detail.kind) || e.detail.kind === 'demo') load(); };
  window.addEventListener('lab-job', onJob);
  await load();
  return () => window.removeEventListener('lab-job', onJob);
}

// ---------------------------------------------------------------- batch import of stereo masters
function parseName(name, path = '') {
  let stem = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  if (/^(master|mix|stereo|final|2.?track|mixdown)$/i.test(stem)) stem = path.split(/[\\/]/).slice(-2, -1)[0] || stem;  // generic name: use the folder
  for (const sep of [' - ', ' – ', ' — ']) if (stem.includes(sep)) { const [a, ...t] = stem.split(sep); return { artist: a.trim(), title: t.join(sep).trim() }; }
  return { artist: '', title: stem };
}

export function batchImport(onDone) {
  let files = [], busy = false;
  const ws = window.lab.ws();
  const opts = { copy: ws.settings.import_mode === 'copy', category: 'music', weight: 1 };
  const body = h('div'), foot = h('div.row');
  const m = modal({ title: 'Import stereo masters', body, wide: true, onClose: () => setDropHandler(null) });
  m.el.querySelector('.mf')?.remove();
  m.el.appendChild(h('div.mf', foot));
  async function add(paths) {
    if (!paths || !paths.length) return;
    try {
      const r = await api.post('/api/files/inspect', { paths });
      const have = new Set(files.map((f) => f.path));
      for (const f of r.files) if (!have.has(f.path)) {
        const words = f.name.replace(/\.[^.]+$/, '').split(/[^A-Za-z0-9]+/).filter(Boolean).length;
        const stemLike = !!f.suggested_group && !f.is_master && (/[\\/](stems?|raw|multitracks?|tracks)[\\/]/i.test(f.path) || words <= 2);  // "Bass.wav", ".../stems/..." 
        files.push({ ...f, ...parseName(f.name, f.path), use: !f.error && !stemLike, stemLike });
      }
      draw();
    } catch (e) { showError(e); }
  }
  setDropHandler(add);
  function draw() {
    const n = files.filter((f) => f.use).length;
    clear(body, h('div.stack',
      h('p.dim', 'Choose mastered stereo songs (WAV, AIFF or FLAC) — individual files or whole folders. Each becomes a reference and is analysed automatically. Names like “Artist - Title” are split for you; edit them below.'),
      h('div.drop', h('div', 'Drag files or folders here from Finder'), h('div.row', { style: { justifyContent: 'center', marginTop: '10px' } },
        h('button', { onclick: async () => add(await pickAudio(true)) }, 'Choose files…'),
        h('button', { onclick: async () => { const p = await pickFolder(); if (p) add([p]); } }, 'Choose a folder…'))),
      files.length ? h('div.scroll-y', { style: { maxHeight: '360px' } }, h('table',
        h('tr', h('th', ''), h('th', 'Title'), h('th', 'Artist'), h('th', 'Length'), h('th', 'Format'), h('th', '')),
        files.map((f, i) => h('tr',
          h('td', h('input', { type: 'checkbox', checked: f.use, disabled: !!f.error, onchange: (e) => { f.use = e.target.checked; draw(); } })),
          h('td', h('input', { value: f.title, style: { width: '100%' }, onchange: (e) => { f.title = e.target.value; } }), h('div.faint.small', f.name, f.stemLike ? h('span', { style: { color: 'var(--warn)' } }, ' · looks like a stem — unticked (attach stems to a reference instead)') : null)),
          h('td', h('input', { value: f.artist, style: { width: '160px' }, onchange: (e) => { f.artist = e.target.value; } })),
          h('td.num', f.error ? h('span', { style: { color: 'var(--danger)' } }, f.error) : fmtTime(f.duration_s)),
          h('td.small.dim', f.sr ? `${f.sr / 1000} kHz · ${f.channels === 1 ? 'mono' : f.channels === 2 ? 'stereo' : f.channels + ' ch'}${f.channels > 2 ? ' (first two used)' : ''}` : ''),
          h('td', h('button.ghost', { onclick: () => { files.splice(i, 1); draw(); } }, '✕')))))) : null,
      files.length ? h('div.form',
        field('Category', select([['music', 'Music'], ['speech', 'Speech'], ['hybrid', 'Hybrid']], opts.category, (v) => { opts.category = v; })),
        field('Weight', h('input', { type: 'number', step: 0.1, min: 0, value: opts.weight, onchange: (e) => { opts.weight = +e.target.value; } }), 'How much each counts in a profile (1 = normal).'),
        field('Storage', select([['ref', 'Reference files where they are (recommended)'], ['copy', 'Copy into the workspace']], opts.copy ? 'copy' : 'ref', (v) => { opts.copy = v === 'copy'; }))) : null,
      h('div#batch-status')));
    clear(foot, h('button', { onclick: () => m.close() }, 'Cancel'), h('div', { style: { flex: 1 } }),
      h('button.primary', { disabled: !n || busy, onclick: go }, n ? `Import ${n} master${n > 1 ? 's' : ''} and analyse` : 'Import'));
  }
  async function go() {
    busy = true; draw();
    const status = body.querySelector('#batch-status');
    try {
      const r = await api.post('/api/library/references/batch', { files: files.filter((f) => f.use).map((f) => ({ path: f.path, title: f.title, artist: f.artist })),
        copy: opts.copy, category: opts.category, weight: opts.weight });
      clear(status, h('p', `${r.created.length} added${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.`),
        r.skipped.map((s) => h('div.finding.warn', h('span.i', '!'), h('span', `${s.name}: ${s.reason}`))), h('p.dim#batch-progress', 'Analysing…'));
      await window.lab.refresh();
      onDone && onDone();
      if (r.job) {
        const j = await waitJob(r.job, (j) => { const p = body.querySelector('#batch-progress'); if (p) p.textContent = `Analysing ${j.text || ''} — ${Math.round((j.fraction || 0) * 100)} %`; });
        const res = j.result || {};
        const p = body.querySelector('#batch-progress');
        if (p) p.textContent = `Analysis finished: ${res.analysed?.length || 0} analysed${res.failed?.length ? `, ${res.failed.length} failed` : ''}.`;
        (res.failed || []).forEach((f) => status.appendChild(h('div.finding.error', h('span.i', '✕'), h('span', f.error))));
        onDone && onDone();
      }
      clear(foot, h('div', { style: { flex: 1 } }), h('button.primary', { onclick: () => m.close() }, 'Done'));
    } catch (e) { showError(e); busy = false; draw(); }
  }
  draw();
}
