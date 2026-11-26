// Settings: workspace, storage, disk usage, missing files, backup, diagnostics, versions.
import { api, waitJob } from '../api.js';
import { h, clear, pageHead, panel, badge, fmtBytes, field, select, showError, toast, promptBox, confirmBox, pickFolder } from '../ui.js';
import { relinkFile } from '../importer.js';

export async function render(root, params, app) {
  const s = app.state, ws = s.workspace, info = s.app;
  const usageBox = h('div', h('p.dim', 'Measuring…'));
  const missingBox = h('div');
  root.append(pageHead('Settings', null),
    h('div.grid.g2',
      h('div',
        panel('Workspace', h('div.stack',
          h('div.kv', h('span', 'Name'), h('b', ws.name), h('span', 'Location'), h('span.mono.small', ws.root)),
          h('div.row',
            h('button', { onclick: async () => { const n = await promptBox('Rename workspace', 'Name', ws.name); if (n) { await api.post('/api/workspace/rename', { name: n }); await app.refresh(); app.route(); } } }, 'Rename'),
            h('button', { onclick: () => api.post('/api/os/reveal', { path: ws.root + '/lab.json' }) }, 'Show in Finder'),
            h('button', { onclick: async () => { const p = await pickFolder(); if (!p) return; try { await api.post('/api/workspace/open', { path: p }); await app.refresh(); app.go('dashboard'); } catch (e) { showError(e); } } }, 'Open another…'),
            h('button', { onclick: async () => { await api.post('/api/workspace/close'); await app.refresh(); app.go('welcome'); } }, 'Close / new workspace…')),
          h('p.faint.small', 'Keep workspaces outside any Git repository. The Lab never commits or uploads anything.'))),
        panel('Importing & listening', h('div.stack',
          field('When importing audio', select([['reference', 'Reference files where they are (no copy)'], ['copy', 'Copy files into the workspace']], ws.settings.import_mode,
            async (v) => { await api.post('/api/workspace/settings', { import_mode: v }); await app.refresh(); toast('Saved'); })),
          field('A/B switch crossfade', h('span', h('input', { type: 'number', min: 0, max: 50, step: 1, value: ws.settings.crossfade_ms ?? 8,
            onchange: async (e) => { await api.post('/api/workspace/settings', { crossfade_ms: +e.target.value }); await app.refresh(); toast('Saved'); } }), ' ms'),
            'A very short fade when switching versions avoids clicks. 0 = hard switch.'),
          h('p.faint.small', 'Listening files are loudness-matched to −18 LUFS when rendered. The output device is chosen in macOS System Settings → Sound.'))),
        panel('Backup', h('div.stack',
          h('p.dim', 'A ZIP of the library records, profiles, experiments and feedback. Audio is left out unless you include it.'),
          h('div.row', h('button', { onclick: () => backup(false) }, 'Back up (no audio)'), h('button', { onclick: () => backup(true) }, 'Back up including copied audio')))),
        panel('Demo material', h('div.stack', h('p.dim', 'Synthetic test signals (not music) with known disturbances, to try every workflow. Marked “synthetic” everywhere and excluded from real-audio evidence.'),
          h('button', { onclick: async () => { try { const r = await api.post('/api/workspace/demo'); toast('Generating demo material…'); await waitJob(r.job); await app.refresh(); toast('Demo material added'); } catch (e) { showError(e); } } }, 'Add demo material')))),
      h('div',
        panel('Disk usage', usageBox),
        panel('Missing files', missingBox),
        panel('Diagnostics', h('div.stack', h('p.dim', 'If something goes wrong, export diagnostics: versions, task errors and failed experiments. Paths are removed and no audio is included.'),
          h('button', { onclick: async () => { try { const r = await api.post('/api/diagnostics/export', {}); toast('Diagnostics saved'); api.post('/api/os/reveal', { path: r.path }); } catch (e) { showError(e); } } }, 'Export diagnostics'))),
        panel('About', h('div.kv',
          h('span', 'Application'), h('span', `${info.name} ${info.app_version}`), h('span', 'Algorithm version'), h('span', info.algorithm_version || '–'),
          h('span', 'Code revision'), h('span.mono', info.git_commit || '–'), h('span', 'Build date'), h('span', info.build_date || (info.frozen ? '–' : 'development')),
          h('span', 'Runtime'), h('span', `Python ${info.python} · ${info.platform}`),
          h('span', 'Privacy'), h('span', 'Runs locally and offline. No cloud AI, no telemetry, no uploads.'))))));

  async function backup(audio) {
    try { const r = await api.post('/api/workspace/backup', { include_audio: audio }); toast('Backup saved'); api.post('/api/os/reveal', { path: r.path }); } catch (e) { showError(e); }
  }
  try {
    const u = await api.get('/api/workspace/usage');
    const U = u.usage;
    clear(usageBox, h('table', [['Experiments (renders, measurements, feedback)', U.experiments], ['Audio copied into the workspace', U.copied_audio], ['Sound Profiles', U.profiles],
      ['Exports', U.exports], ['Temporary files (safe to delete)', U.cache], ['Referenced audio outside the workspace', U.external_audio_referenced]].map(([l, v]) => h('tr', h('td', l), h('td.num', fmtBytes(v))))),
      h('p.faint.small', 'To save space, delete rendered audio of old experiments in Experiment History (measurements and feedback are kept).'));
    const libs = {};
    for (const k of ['references', 'mixes', 'speech']) libs[k] = (await api.get(`/api/library/${k}`)).items;
    clear(missingBox, u.missing.length ? [h('p.dim', 'These files were moved or renamed. Relink each one to its new location; the Lab checks it is the same file.'),
      h('table', u.missing.map((m) => h('tr', h('td', m.item, h('div.faint.small', m.kind)), h('td', m.name, h('div.faint.small', m.path)),
        h('td', h('button', { onclick: () => relinkFile(m.kind, libs[m.kind].find((x) => x.id === m.item_id), { id: m.file_id }, () => app.route()) }, 'Relink…')))))]
      : h('p.dim', '✓ All library files are where they were imported from.'));
  } catch (e) { if (window.lab.ws()) showError(e); }
}
