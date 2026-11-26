// Shell: navigation, routing, workspace chip, job tray.
import { api, onJobs, pollJobs } from './api.js';
import { h, clear, toast, showError, setDropHandler, badge } from './ui.js';

const NAV = [
  ['Overview', [['dashboard', 'Dashboard', '◧']]],
  ['Library', [['references', 'Reference Library', '♫'], ['profiles', 'Sound Profiles', '◔']]],
  ['Labs', [['music', 'Music Lab', '▤'], ['speech', 'Speech Lab', '◉'], ['broadcast', 'Broadcast Compare', '◎'], ['listen', 'Listening Room', '◑'], ['studies', 'Research Studies', '∿']]],
  ['Records', [['history', 'Experiment History', '☰'], ['feedback', 'Engineer Feedback', '✎'], ['export', 'Research Export', '⇪']]],
  ['', [['settings', 'Settings', '⚙']]],
  ['Planned modules', [['planned/plugin', 'Plugin Intelligence Lab'], ['planned/hybrid', 'Hybrid Lab'], ['planned/ambience', 'Ambience Lab'],
    ['planned/program', 'Program Lab'], ['planned/teach', 'Teach Mode'], ['planned/soundcheck', 'Virtual Soundcheck import']]],
];

const PAGES = {
  welcome: () => import('./pages/welcome.js'), dashboard: () => import('./pages/dashboard.js'),
  references: () => import('./pages/references.js'), profiles: () => import('./pages/profiles.js'),
  music: () => import('./pages/music.js'), speech: () => import('./pages/speech.js'),
  listen: () => import('./pages/listen.js'), studies: () => import('./pages/studies.js'),
  history: () => import('./pages/history.js'), feedback: () => import('./pages/feedback.js'),
  export: () => import('./pages/export.js'), settings: () => import('./pages/settings.js'),
  planned: () => import('./pages/planned.js'), broadcast: () => import('./pages/broadcast.js'),
};

export const expRoute = (e) => (e.type === 'study' ? `studies/${e.id}` : e.type === 'program' ? `broadcast/${e.id}` : `listen/${e.id}`);

export const app = {
  expRoute,
  state: null,
  async refresh() {
    this.state = await api.get('/api/state');
    renderChrome();
    return this.state;
  },
  go(path) { if (location.hash === '#/' + path) route(); else location.hash = '#/' + path; },
  ws() { return this.state && this.state.workspace; },
};
window.lab = app; // for debugging in the developer console

function renderChrome() {
  const s = app.state;
  document.getElementById('ver').textContent = `v${s.app.app_version} · algorithms ${s.app.algorithm_version || '?'}`;
  const chip = document.getElementById('ws-chip');
  clear(chip, s.workspace ? [h('span', 'Workspace'), h('b', s.workspace.name), h('button.ghost', { onclick: () => app.go('settings') }, 'Change…')] : h('span', 'No workspace open'));
  const cur = (location.hash.slice(2) || 'dashboard');
  const nav = document.getElementById('nav');
  clear(nav, NAV.map(([sec, items]) => [sec ? h('div.sec', sec) : h('div.sep'),
    items.map(([id, label, ic]) => h('a' + (cur === id || cur.startsWith(id + '/') ? '.on' : '') + (id.startsWith('planned') ? '.future' : ''),
      { href: '#/' + id, onclick: (e) => { if (!s.workspace && !id.startsWith('planned')) { e.preventDefault(); app.go('welcome'); } } },
      h('span.ic', ic || '·'), label, id.startsWith('planned') ? h('span.tag', 'planned') : null))]));
}

function renderJobs(jobs) {
  const bar = document.getElementById('status');
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const last = jobs.find((j) => !active.includes(j));
  clear(bar,
    active.length ? active.map((j) => h('div.job', h('b', j.title), h('span', j.stage || j.status), h('div.bar', h('i', { style: { width: `${Math.round((j.fraction || 0) * 100)}%` } })),
      h('button.ghost.small', { onclick: () => api.post(`/api/jobs/${j.id}/cancel`).then(pollJobs) }, 'Cancel')))
      : h('span', last ? `Last task: ${last.title} — ${last.status === 'done' ? 'finished' : last.status}` : 'Ready'),
    h('div', { style: { flex: 1 } }),
    h('span', 'Experimental research tool. Nothing here controls a live console.'));
}

let seenJobs = {};
function notifyJobs(jobs) {
  for (const j of jobs) {
    const prev = seenJobs[j.id];
    if (prev && prev !== j.status && ['done', 'error', 'cancelled'].includes(j.status)) {
      toast(j.status === 'done' ? `${j.title}: finished` : `${j.title}: ${j.status === 'error' ? 'failed — ' + (j.error || '').split('\n')[0] : 'cancelled'}`, j.status === 'error');
      if (j.status === 'done') app.refresh().catch(() => {});
      window.dispatchEvent(new CustomEvent('lab-job', { detail: j }));
    }
    seenJobs[j.id] = j.status;
  }
}

let cleanup = null;
async function route() {
  const path = location.hash.replace(/^#\/?/, '') || '';
  let [page, ...rest] = path.split('/');
  const s = app.state;
  if (!s.workspace && page !== 'planned') page = 'welcome';
  if (!page) page = 'dashboard';
  if (!PAGES[page]) page = 'dashboard';
  renderChrome();
  if (cleanup) { try { cleanup(); } catch (e) {} cleanup = null; }
  setDropHandler(null);
  const main = document.getElementById('main');
  main.scrollTop = 0;
  try {
    const mod = await PAGES[page]();
    clear(main);
    cleanup = (await mod.render(main, rest.map(decodeURIComponent), app)) || null;
  } catch (e) {
    showError(e);
    clear(main, h('div.empty', h('div.t', 'This page could not be shown'), h('p', e.message)));
  }
}
app.route = route;

window.addEventListener('hashchange', route);
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

(async function start() {
  try {
    await app.refresh();
  } catch (e) {
    clear(document.getElementById('main'), h('div.empty', h('div.t', 'The Lab could not start'), h('p', e.message),
      h('p.dim', 'Quit and reopen Merge Intelligence Lab. If this keeps happening, use Settings → Export diagnostics.')));
    return;
  }
  onJobs((j) => { renderJobs(j); notifyJobs(j); });
  pollJobs();
  route();
})();
export { badge };
