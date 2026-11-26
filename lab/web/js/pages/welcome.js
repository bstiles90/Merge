// First launch and workspace selection.
import { api, waitJob } from '../api.js';
import { h, clear, field, pickFolder, showError, toast } from '../ui.js';

export async function render(root, params, app) {
  const s = app.state;
  const parent = h('input', { value: s.default_workspace_parent, style: { flex: 1 } });
  const name = h('input', { value: 'Worship research', style: { width: '100%' } });
  const demo = h('input', { type: 'checkbox', checked: !s.onboarding_done });
  const status = h('div');

  async function create() {
    try {
      clear(status, h('p.dim', 'Creating the workspace…'));
      const r = await api.post('/api/workspace/create', { parent: parent.value, name: name.value, demo: demo.checked });
      await api.post('/api/onboarding/done');
      if (r.job) {
        clear(status, h('p.dim', 'Generating synthetic demo material (about a minute)…'));
        await waitJob(r.job, (j) => clear(status, h('p.dim', `${j.stage || 'Working'}… ${Math.round((j.fraction || 0) * 100)} %`)));
        toast('Demo material is in the library. It is synthetic test signal, not music.');
      }
      await app.refresh();
      app.go('dashboard');
    } catch (e) { showError(e); clear(status); }
  }
  async function openExisting(path) {
    try {
      path = path || await pickFolder();
      if (!path) return;
      await api.post('/api/workspace/open', { path });
      await api.post('/api/onboarding/done');
      await app.refresh();
      app.go('dashboard');
    } catch (e) { showError(e); }
  }

  root.append(h('div.onboard',
    h('div.hero',
      h('h1', 'Merge Intelligence Lab'),
      h('p', 'A research bench for Merge Intelligence. Import reference recordings, build Sound Profiles, let the experimental operator adjust your own stems, then listen, judge and record what it got right and wrong.'),
      h('div.cards3',
        h('div.card', h('b', '1 · References'), h('span.dim', 'Mastered songs with stems that have the sound you want. They teach the profile how sources relate.')),
        h('div.card', h('b', '2 · Your mix'), h('span.dim', 'Group stems from your own service (vocals, drums, bass, guitars, keys). The operator proposes level changes.')),
        h('div.card', h('b', '3 · Listen & judge'), h('span.dim', 'Switch instantly between original and adjusted, run blind tests, and mark each decision.')))),
    h('div.notice', { style: { marginTop: '14px' } },
      h('b', 'Everything stays on this computer. '),
      'No cloud AI, no uploads, no account. Your audio is referenced where it already is (not copied) unless you choose otherwise, and the Lab never deletes your originals. ',
      'The Lab is experimental and never controls a live console.'),
    h('div.grid.g2',
      h('div.panel', h('div.ph', h('h2', 'Create a workspace')), h('div.pb.stack',
        h('p.dim', 'A workspace is a folder holding your library, profiles, experiments and feedback. Keep it out of any Git repository.'),
        field('Name', name),
        field('Location', h('div.row', parent, h('button', { onclick: async () => { const p = await pickFolder(); if (p) parent.value = p; } }, 'Choose…'))),
        h('label.row', demo, h('span', 'Add synthetic demo material so you can try the whole workflow right away')),
        h('div.row', h('button.primary.big', { onclick: create }, 'Create workspace')), status)),
      h('div.panel', h('div.ph', h('h2', 'Open a workspace')), h('div.pb.stack',
        h('button.big', { onclick: () => openExisting() }, 'Open a workspace folder…'),
        s.recent_workspaces.length ? [h('h3', 'Recent'), s.recent_workspaces.map((p) => h('div.row', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openExisting(p); } }, p.split(/[\\/]/).pop()), h('span.faint.small', p)))]
          : h('p.dim', 'No recent workspaces.'))))));
}
