// Import wizard shared by references, comparison mixes and speech recordings:
// choose files -> confirm roles -> check -> details -> save.
import { api, waitJob } from './api.js';
import { h, clear, modal, field, pickAudio, pickFolder, showError, toast, setDropHandler, fmtTime, groupName, GROUPS, select, help } from './ui.js';

const KIND = {
  reference: { lib: 'references', title: 'Import a reference recording', noun: 'reference' },
  mix: { lib: 'mixes', title: 'Import a comparison mix', noun: 'mix' },
  speech: { lib: 'speech', title: 'Import a speech recording', noun: 'speech recording' },
};

function roleOptions(kind, attach) {
  if (attach) return [...GROUPS.map((g) => [g, `${groupName(g)} stem`]), ['', 'Ignore this file']];
  if (kind === 'reference') return [['master', 'Master (stereo song)'], ...GROUPS.map((g) => [g, `${groupName(g)} stem`]), ['', 'Ignore this file']];
  if (kind === 'mix') return [['mix', 'Stereo mix (optional)'], ...GROUPS.map((g) => [g, `${groupName(g)} stem`]),
    ...GROUPS.map((g) => ['raw:' + g, `${groupName(g)} — raw, before plugins`]), ['', 'Ignore this file']];
  return [['speech', 'Speech microphone'], ['audience', 'Audience / ambience (excluded)'], ['music', 'Music / playback (excluded)'], ['', 'Ignore this file']];
}
function guessRole(kind, f) {
  if (kind === 'speech') return /aud|amb|room|crowd/i.test(f.name) ? 'audience' : /music|track|play|band/i.test(f.name) ? 'music' : 'speech';
  if (f.is_master || /^(master|mix|stereo|2.?track)/i.test(f.name.replace(/\.[^.]+$/, ''))) return kind === 'reference' ? 'master' : 'mix';
  const inRaw = /[\\/]raw[\\/]/i.test(f.path);
  return f.suggested_group ? (inRaw && kind === 'mix' ? 'raw:' + f.suggested_group : f.suggested_group) : '';
}

export function openImporter(kind, { item, onDone, attachTo } = {}) {
  const K = KIND[kind];
  let files = [], step = 0, validation = null, busy = false;
  const ws = window.lab.ws();
  const details = item ? { ...item } : (kind === 'reference'
    ? { title: '', artist: '', album: '', version: '', category: 'music', arrangement: '', weight: 1, include: true, notes: '' }
    : { name: '', notes: '' });
  const copyMode = { copy: ws.settings.import_mode === 'copy' };
  const body = h('div');
  const m = modal({ title: attachTo ? `Attach stems to “${attachTo.title || 'reference'}”` : K.title, body, wide: true, onClose: () => setDropHandler(null) });
  const foot = m.el.querySelector('.mf') || m.el.appendChild(h('div.mf'));

  async function addPaths(paths) {
    if (!paths || !paths.length) return;
    try {
      const r = await api.post('/api/files/inspect', { paths });
      const have = new Set(files.map((f) => f.path));
      for (const f of r.files) if (!have.has(f.path)) {
        let role = guessRole(kind, f);
        if (attachTo && role === 'master') role = f.suggested_group || '';
        if (attachTo && attachTo.master && f.path === attachTo.master.path) continue;  // the master is already attached
        files.push({ ...f, role, mname: f.name.replace(/\.[^.]+$/, ''), weight_db: 0 });
      }
      if (kind === 'reference' && !details.title && !attachTo) {
        const master = files.find((f) => f.role === 'master') || files[0];
        const dir = master.path.split(/[\\/]/).slice(-2, -1)[0];
        details.title = dir && !/stems?|audio|bounces?/i.test(dir) ? dir : '';
      }
      if (kind !== 'reference' && !details.name) details.name = (files[0].path.split(/[\\/]/).slice(-2, -1)[0] || '').replace(/stems?/i, '').trim() || files[0].mname;
      validation = null;
      draw();
    } catch (e) { showError(e); }
  }
  setDropHandler(addPaths);

  const steps = ['Files', 'Roles', 'Check', 'Details'];
  function draw() {
    clear(body, h('div.steps', steps.map((s, i) => h('span' + (i === step ? '.on' : i < step ? '.done' : ''), `${i + 1}. ${s}`))), [stepFiles, stepRoles, stepCheck, stepDetails][step]());
    clear(foot,
      h('button', { onclick: () => m.close() }, 'Cancel'), h('div', { style: { flex: 1 } }),
      step > 0 ? h('button', { onclick: () => { step--; draw(); } }, 'Back') : null,
      step < 3 ? h('button.primary', { disabled: !canNext() || busy, onclick: next }, step === 1 ? 'Check files' : 'Next') : h('button.primary', { disabled: busy, onclick: save }, attachTo ? 'Attach stems' : item ? 'Save' : 'Add to library'));
  }
  function canNext() {
    const used = files.filter((f) => f.role && !f.error);
    if (step === 0) return files.length > 0;
    if (step === 1) {
      if (attachTo) return used.some((f) => GROUPS.includes(f.role));
      if (kind === 'reference') return used.some((f) => GROUPS.includes(f.role) || f.role === 'master');
      if (kind === 'mix') return used.filter((f) => GROUPS.includes(f.role)).length >= 2;
      return used.some((f) => f.role === 'speech');
    }
    if (step === 2) return validation && validation.status !== 'error';
    return true;
  }
  async function next() {
    if (step === 1) { step = 2; draw(); await check(); return; }
    step++; draw();
  }

  function stepFiles() {
    const hint = {
      reference: 'Choose the mastered song (master) and its stems: vocals, drums, bass, guitars, keys. All files must start at the same moment. A folder can be chosen.',
      mix: 'Choose group stems from your own service: one file per group (vocals, drums, bass, guitars, keys), all the same length. Optionally add the stereo mix, and raw stems recorded before plugins (enables the processing study).',
      speech: 'Choose one file per microphone (pastor headset, handheld, pulpit…), all recorded at the same time and the same length. Audience microphones can be included and are excluded from gain sharing.',
    }[kind];
    return h('div.stack',
      h('p.dim', hint),
      h('div.drop', { id: 'drop' }, h('div', 'Drag files or a folder here from Finder'), h('div.row', { style: { justifyContent: 'center', marginTop: '10px' } },
        h('button', { onclick: async () => addPaths(await pickAudio(true)) }, 'Choose files…'),
        h('button', { onclick: async () => { const p = await pickFolder(); if (p) addPaths([p]); } }, 'Choose a folder…'))),
      files.length ? fileTable(false) : null);
  }
  function fileTable(editable) {
    return h('table',
      h('tr', h('th', 'File'), h('th', 'Role'), kind === 'speech' && editable ? [h('th', 'Name'), h('th', ['Weight ', help('Raises or lowers this mic in gain sharing, in dB. Use it to favour the pastor, or to compensate for a quiet mic.')])] : null,
        h('th', 'Length'), h('th', 'Format'), h('th', '')),
      files.map((f, i) => h('tr',
        h('td', h('div', f.name), h('div.faint.small', f.path.length > 70 ? '…' + f.path.slice(-70) : f.path)),
        h('td', editable ? select(roleOptions(kind, !!attachTo), f.role, (v) => { f.role = v; validation = null; draw(); }) : h('span', (roleOptions(kind, !!attachTo).find((o) => o[0] === f.role) || [0, 'Not recognised'])[1])),
        kind === 'speech' && editable ? [h('td', h('input', { value: f.mname, style: { width: '120px' }, onchange: (e) => { f.mname = e.target.value; } })),
          h('td', h('input', { type: 'number', step: 0.5, value: f.weight_db, onchange: (e) => { f.weight_db = +e.target.value; } }))] : null,
        h('td.num', f.error ? h('span', { style: { color: 'var(--danger)' } }, f.error) : fmtTime(f.duration_s)),
        h('td.small.dim', f.sr ? `${f.sr / 1000} kHz · ${(f.subtype || '').replace('PCM_', '')}${/^\d/.test((f.subtype || '').replace('PCM_', '')) ? '-bit' : ''} · ${f.channels === 1 ? 'mono' : f.channels === 2 ? 'stereo' : f.channels + ' ch'}` : ''),
        h('td', h('button.ghost', { title: 'Remove from this import', onclick: () => { files.splice(i, 1); validation = null; draw(); } }, '✕')))));
  }
  function stepRoles() {
    const unknown = files.filter((f) => !f.role).length;
    return h('div.stack',
      h('p.dim', 'Roles were suggested from the file names. Correct anything that is wrong. Several files in one group are summed (e.g. two guitar stems).'),
      unknown ? h('div.notice.warn', `${unknown} file(s) were not recognised and will be ignored unless you choose a role.`) : null,
      fileTable(true));
  }
  async function check() {
    busy = true; draw();
    const used = files.filter((f) => f.role && !f.error);
    const master = attachTo ? null : used.find((f) => f.role === 'master' || f.role === 'mix');
    const payload = { kind, master: master ? master.path : (attachTo?.master?.path || null), files: used.filter((f) => f !== master).map((f) => ({ path: f.path, group: f.role.replace('raw:', '') })) };
    if (kind === 'mix') payload.files = payload.files.filter((f, i) => !used.filter((x) => x !== master)[i].role.startsWith('raw:'));
    const box = body.querySelector('#check');
    try {
      const r = await api.post('/api/validate', payload);
      const j = await waitJob(r.job, (j) => { const b = body.querySelector('#check'); if (b) clear(b, h('p.dim', `${j.stage || 'Checking'} ${j.text || ''} — ${Math.round((j.fraction || 0) * 100)} %`)); });
      validation = j.result;
    } catch (e) { showError(e); validation = { status: 'error', findings: [{ level: 'error', text: e.message }], files: [] }; }
    busy = false; draw();
  }
  function stepCheck() {
    if (!validation) return h('div', h('p.dim', 'The files are being checked: format, length, peaks, clipping, loudness, and whether the stems add up to the master.'), h('div#check'));
    const icon = { error: '✕', warn: '!', info: 'i', ok: '✓' };
    return h('div.stack',
      h('div.notice' + (validation.status === 'ok' ? '' : '.warn'), validation.status === 'error' ? 'These files cannot be used as they are. Fix the problems below and import again.'
        : validation.status === 'warn' ? 'The files can be used, but please read the warnings.' : 'The files look good.'),
      validation.findings.map((f) => h('div.finding.' + f.level, h('span.i', icon[f.level] || '·'), h('span', f.text))),
      h('h3', 'Measurements'),
      h('table', h('tr', h('th', 'File'), h('th', 'Role'), h('th', 'Length'), h('th', 'Peak'), h('th', 'Loudness'), h('th', 'Clipped samples')),
        validation.files.map((f) => h('tr', h('td', f.name), h('td', f.group === 'master' ? (kind === 'reference' ? 'Master' : 'Stereo mix') : groupName(f.group)),
          h('td.num', fmtTime(f.duration_s)), h('td.num', f.peak_dbfs != null ? `${f.peak_dbfs.toFixed(1)} dBFS` : '–'),
          h('td.num', f.integrated_LUFS != null ? `${f.integrated_LUFS.toFixed(1)} LUFS` : '–'), h('td.num', f.clipped_samples ?? '–')))),
      validation.reconstruction_error_dB != null ? h('p.dim.small', `Reconstruction error: ${validation.reconstruction_error_dB.toFixed(1)} dB · alignment ${validation.alignment_ms != null ? validation.alignment_ms.toFixed(2) + ' ms' : '–'}`) : null);
  }
  function stepDetails() {
    if (attachTo) return h('div.stack', h('p', `The stems will be attached to “${attachTo.title}”. Its master and programme analysis stay as they are.`),
      h('p.dim', 'Existing Sound Profiles are not changed. To use the stems, build a new version of a profile (Sound Profiles → Duplicate / regenerate).'),
      h('h3', 'Storage'),
      h('label.row', h('input', { type: 'radio', name: 'store', checked: !copyMode.copy, onchange: () => { copyMode.copy = false; } }), h('span', 'Reference the files where they are (recommended)')),
      h('label.row', h('input', { type: 'radio', name: 'store', checked: copyMode.copy, onchange: () => { copyMode.copy = true; } }), h('span', 'Copy into the workspace')));
    const inp = (k, attrs = {}) => h('input', { value: details[k] ?? '', ...attrs, onchange: (e) => { details[k] = attrs.type === 'number' ? +e.target.value : e.target.value; } });
    const storage = h('div.stack',
      h('h3', 'Storage'),
      h('label.row', h('input', { type: 'radio', name: 'store', checked: !copyMode.copy, onchange: () => { copyMode.copy = false; } }),
        h('span', h('b', 'Reference the files where they are'), h('span.dim', ' (recommended — no extra disk space; if you move them, the Lab will ask you to relink)'))),
      h('label.row', h('input', { type: 'radio', name: 'store', checked: copyMode.copy, onchange: () => { copyMode.copy = true; } }),
        h('span', h('b', 'Copy into the workspace'), h('span.dim', ' (uses disk space; the workspace becomes self-contained)'))),
      h('p.faint.small', 'Either way, your original files are never modified or deleted.'));
    if (kind === 'reference') return h('div.stack', h('div.form',
      field('Song title', inp('title')), field('Artist', inp('artist')), field('Album', inp('album')), field('Version', inp('version', { placeholder: 'e.g. live, radio edit' })),
      field('Category', select([['music', 'Music'], ['speech', 'Speech'], ['hybrid', 'Hybrid']], details.category, (v) => { details.category = v; })),
      field('Arrangement / style', inp('arrangement', { placeholder: 'e.g. full band, acoustic' })),
      field('Weight', inp('weight', { type: 'number', step: 0.1, min: 0 }), 'How much this reference counts in a profile, relative to the others (1 = normal). Use less for references whose stems are imperfect.'),
      field('Use in new profiles', h('input', { type: 'checkbox', checked: details.include !== false, onchange: (e) => { details.include = e.target.checked; } }))),
      field('Notes', h('textarea', { value: details.notes || '', onchange: (e) => { details.notes = e.target.value; } })), item ? null : storage);
    return h('div.stack', h('div.form', field('Name', inp('name', { placeholder: kind === 'mix' ? 'e.g. Sunday 3 Nov — Way Maker' : 'e.g. Sunday 3 Nov — sermon' }))),
      field('Notes', h('textarea', { value: details.notes || '', onchange: (e) => { details.notes = e.target.value; } })), item ? null : storage);
  }

  async function save() {
    busy = true; draw();
    try {
      const used = files.filter((f) => f.role && !f.error);
      const body = { copy: copyMode.copy, validation: { status: validation.status, findings: validation.findings, files: validation.files.map(({ path, ...rest }) => rest),
        reconstruction_error_dB: validation.reconstruction_error_dB, alignment_ms: validation.alignment_ms, checked: validation.checked } };
      if (attachTo) {
        body.id = attachTo.id;
        body.stems = used.filter((f) => GROUPS.includes(f.role)).map((f) => ({ path: f.path, group: f.role }));
        const r = await api.post('/api/library/references/attach-stems', body);
        toast(`Stems attached to “${r.item.title}”`);
        m.close(); await window.lab.refresh(); onDone && onDone(r.item);
        return;
      }
      if (kind === 'reference') {
        body.item = details;
        const ms = used.find((f) => f.role === 'master'); if (ms) body.master = ms.path;
        body.stems = used.filter((f) => GROUPS.includes(f.role)).map((f) => ({ path: f.path, group: f.role }));
      } else if (kind === 'mix') {
        body.item = details;
        const mx = used.find((f) => f.role === 'mix'); if (mx) body.mix = mx.path;
        body.stems = used.filter((f) => GROUPS.includes(f.role)).map((f) => ({ path: f.path, group: f.role }));
        body.raw = used.filter((f) => f.role.startsWith('raw:')).map((f) => ({ path: f.path, group: f.role.slice(4) }));
      } else {
        body.item = details;
        body.mics = used.map((f) => ({ path: f.path, name: f.mname, role: f.role, weight_db: f.weight_db }));
      }
      const r = await api.post(`/api/library/${K.lib}/add`, body);
      toast(`Added “${r.item.title || r.item.name}” to the library${r.job ? ' — analysing the master' : ''}`);
      m.close();
      await window.lab.refresh();
      onDone && onDone(r.item);
    } catch (e) { showError(e); busy = false; draw(); }
  }
  draw();
  return m;
}

// Edit the descriptive details of an existing library item.
export function editDetails(kind, it, onDone) {
  const lib = KIND[kind].lib;
  const d = { ...it };
  const inp = (k, attrs = {}) => h('input', { value: d[k] ?? '', ...attrs, onchange: (e) => { d[k] = attrs.type === 'number' ? +e.target.value : e.target.value; } });
  const fields = kind === 'reference'
    ? [field('Song title', inp('title')), field('Artist', inp('artist')), field('Album', inp('album')), field('Version', inp('version')),
      field('Category', select([['music', 'Music'], ['speech', 'Speech'], ['hybrid', 'Hybrid']], d.category, (v) => { d.category = v; })),
      field('Arrangement / style', inp('arrangement')), field('Weight', inp('weight', { type: 'number', step: 0.1, min: 0 })),
      field('Use in new profiles', h('input', { type: 'checkbox', checked: d.include !== false, onchange: (e) => { d.include = e.target.checked; } }))]
    : [field('Name', inp('name'))];
  modal({ title: 'Edit details', body: h('div.stack', h('div.form', fields), field('Notes', h('textarea', { value: d.notes || '', onchange: (e) => { d.notes = e.target.value; } }))),
    actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, run: async () => {
      const keys = kind === 'reference' ? ['title', 'artist', 'album', 'version', 'category', 'arrangement', 'weight', 'include', 'notes'] : ['name', 'notes'];
      await api.post(`/api/library/${lib}/update`, { id: it.id, patch: Object.fromEntries(keys.map((k) => [k, d[k]])) });
      onDone && onDone();
    } }] });
}

// Relink a missing file (moved or renamed).
export async function relinkFile(kind, item, file, onDone) {
  const paths = await pickAudio(false);
  if (!paths || !paths[0]) return;
  try {
    const r = await api.post('/api/library/relink', { kind, item_id: item.id, file_id: file.id, path: paths[0] });
    if (!r.ok) {
      const ok = await new Promise((res) => modal({ title: 'This looks like a different file', body: h('p', (r.reason || 'The chosen file does not match the original.') + ' Use it anyway?'),
        actions: [{ label: 'Cancel', run: () => res(false) }, { label: 'Use it anyway', danger: true, run: () => res(true) }] }));
      if (!ok) return;
      await api.post('/api/library/relink', { kind, item_id: item.id, file_id: file.id, path: paths[0], force: true });
    }
    toast('File relinked');
    onDone && onDone();
  } catch (e) { showError(e); }
}
