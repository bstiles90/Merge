// Reference Library: mastered songs with stems that define the sound you want.
import { api } from '../api.js';
import { h, clear, pageHead, panel, badge, empty, fmtTime, groupName, confirmBox, showError, toast, modal, fmtDate } from '../ui.js';
import { openImporter, editDetails, relinkFile } from '../importer.js';
import { quickPlayer } from '../quickplay.js';

export async function render(root, params, app) {
  const body = h('div');
  root.append(pageHead('Reference Library', 'Recordings whose balance you want Merge to learn from. Each needs its stems; the master is used for reconstruction checks and programme context.',
    h('button.primary', { onclick: () => openImporter('reference', { onDone: load }) }, '+ Import reference')), body);
  async function load() {
    const { items } = await api.get('/api/library/references');
    if (!items.length) return clear(body, panel('References', empty('No references yet', 'Import a mastered song together with its vocal, drum, bass, guitar and keys stems.',
      h('button.primary', { onclick: () => openImporter('reference', { onDone: load }) }, 'Import a reference'))));
    clear(body, h('div.panel.flat', h('div.pb', h('table',
      h('tr', h('th', 'Song'), h('th', 'Category'), h('th', 'Stems'), h('th', 'Length'), h('th', 'Check'), h('th', 'Weight'), h('th', 'In profiles'), h('th', '')),
      items.map((it) => row(it))))));
  }
  function row(it) {
    const v = it.validation;
    const groups = [...new Set((it.stems || []).map((s) => s.group))];
    return h('tr',
      h('td', h('b', it.title || '(untitled)'), it.synthetic ? [' ', badge('synthetic', 'synthetic-data')] : null,
        h('div.dim.small', [it.artist, it.album, it.version].filter(Boolean).join(' · ') || ''),
        it._missing && it._missing.length ? h('div', badge(`${it._missing.length} file(s) missing`, 'error')) : null),
      h('td', it.category || 'music', it.arrangement ? h('div.faint.small', it.arrangement) : null),
      h('td.small', groups.map(groupName).join(', '), it.master ? h('div.faint', '+ master') : h('div.faint', 'no master')),
      h('td.num', fmtTime((it.master || it.stems?.[0]?.file || {}).duration_s)),
      h('td', v ? badge(v.status === 'ok' ? 'Good' : v.status === 'warn' ? 'Warnings' : 'Problems', v.status === 'ok' ? 'ok' : v.status === 'warn' ? 'warn' : 'error') : badge('Not checked', 'info'),
        v && v.reconstruction_error_dB != null ? h('div.faint.small', `recon ${v.reconstruction_error_dB.toFixed(1)} dB`) : null),
      h('td.num', (it.weight ?? 1).toFixed(1)),
      h('td', it.include === false ? h('span.dim', 'excluded') : '✓'),
      h('td', h('div.row.tight',
        it.master ? h('button.ghost', { title: 'Play the master', onclick: () => quickPlayer(it.title, { path: it.master.path }) }, '▶') : null,
        h('button.ghost', { onclick: () => showItem(it) }, 'Details'),
        h('button.ghost', { onclick: () => editDetails('reference', it, load) }, 'Edit'),
        h('button.ghost', { onclick: () => remove(it) }, 'Remove'))));
  }
  function showItem(it) {
    const files = [it.master ? { f: it.master, role: 'Master' } : null, ...(it.stems || []).map((s) => ({ f: s.file, role: groupName(s.group) + ' stem' }))].filter(Boolean);
    const m = modal({ title: it.title || 'Reference', wide: true, body: h('div.stack',
      h('div.kv', h('span', 'Artist'), h('span', it.artist || '–'), h('span', 'Album'), h('span', it.album || '–'), h('span', 'Category'), h('span', it.category),
        h('span', 'Imported'), h('span', fmtDate(it.created)), h('span', 'Notes'), h('span', it.notes || '–')),
      h('h3', 'Files'),
      h('table', h('tr', h('th', 'Role'), h('th', 'File'), h('th', 'Stored'), h('th', '')),
        files.map(({ f, role }) => h('tr', h('td', role), h('td', f.name, h('div.faint.small', f.path)), h('td.small', f.stored === 'workspace' ? 'copied into workspace' : 'referenced'),
          h('td', (it._missing || []).includes(f.name) ? h('button', { onclick: () => relinkFile('references', it, f, () => { m.close(); load(); }) }, 'Relink…') : null)))),
      it.validation ? [h('h3', 'Check results'), it.validation.findings.map((x) => h('div.finding.' + x.level, h('span.i', x.level === 'ok' ? '✓' : x.level === 'error' ? '✕' : x.level === 'warn' ? '!' : 'i'), h('span', x.text)))] : null),
      actions: [{ label: 'Close' }] });
  }
  async function remove(it) {
    const copied = [it.master, ...(it.stems || []).map((s) => s.file)].filter((f) => f && f.stored === 'workspace').length;
    if (!await confirmBox('Remove reference', `Remove “${it.title}” from the library? Existing profiles keep their measurements. ${copied ? `${copied} copied file(s) inside the workspace will be deleted. ` : ''}Your original files are not touched.`, 'Remove', true)) return;
    try { await api.post('/api/library/references/remove', { id: it.id, delete_copied: true }); toast('Removed'); await app.refresh(); load(); } catch (e) { showError(e); }
  }
  await load();
}
