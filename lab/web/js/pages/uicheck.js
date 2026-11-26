// CI only (--ui-check): drive the Music Lab import wizard in the real window with full-length stems,
// exactly as an engineer would after dropping files from Finder, and measure page responsiveness.
import { api, clientLog } from '../api.js';
import { h, clear } from '../ui.js';
import { openImporter } from '../importer.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { const v = fn(); if (v) return v; await wait(100); }
  throw new Error(`timed out waiting for ${what}`);
}
async function jobDone(id) {
  for (;;) {
    const j = (await api.get(`/api/jobs/${id}`)).job;
    if (j.status === 'done') return j;
    if (j.status === 'error' || j.status === 'cancelled') throw new Error(`${j.title}: ${j.error || j.status}`);
    await wait(500);
  }
}
const btn = (text) => [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim().startsWith(text) && !b.disabled);

export async function render(root, params, app) {
  const log = h('pre.prompt');
  root.append(h('h1', 'UI check'), log);
  const say = (s) => { log.textContent += s + '\n'; };
  let maxGap = 0, last = performance.now();
  const hb = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 100);
  const R = { steps: {} };
  const t = async (name, fn) => { const a = performance.now(); await fn(); R.steps[name] = Math.round(performance.now() - a); say(`${name}: ${R.steps[name]} ms (worst page gap so far ${Math.round(maxGap)} ms)`); };
  try {
    const cfg = await api.get('/api/uicheck-config');
    if (!app.ws()) { await api.post('/api/workspace/create', { parent: cfg.dir + '/workspace', name: 'UI check' }); await app.refresh(); }
    app.go('music'); await wait(800);
    await t('open wizard + drop files', async () => {
      openImporter('mix');
      window.labDropped([cfg.dir + '/stems']);
      await until(() => document.querySelectorAll('.modal table tr').length >= 8, 60000, 'file list');
    });
    await t('roles', async () => { (await until(() => btn('Next'), 10000, 'Next')).click(); await until(() => btn('Check files'), 10000, 'Check'); });
    await t('check files', async () => { btn('Check files').click(); await until(() => document.querySelector('.modal .notice'), 280000, 'check result'); });
    R.check_notice = document.querySelector('.modal .notice')?.textContent;
    await t('add to library', async () => {
      (await until(() => btn('Next'), 10000, 'Next')).click();
      (await until(() => btn('Add to library'), 10000, 'Add')).click();
      await until(() => !document.querySelector('.modal-bg'), 60000, 'wizard to close');
    });
    await wait(3000); // Music Lab draws the new mix (waveforms of six long stems)
    // phase 2: a full analysis of these stems, then every page in this window (WebKit) must render
    await t('analyse the mix', async () => {
      const mix = (await api.get('/api/library/mixes')).items[0];
      const G = Object.fromEntries(mix.stems.map((s) => [s.file.name, s.group]));
      const ref = await api.post('/api/library/references/add', { item: { title: 'UI check reference' }, master: mix.mix.path,
        stems: mix.stems.map((s) => ({ path: s.file.path, group: G[s.file.name] })) });
      const p = await api.post('/api/profiles/create', { name: 'UI check profile', reference_ids: [ref.item.id] });
      await jobDone(p.job);
      const e = await api.post('/api/experiments/music', { name: 'UI check run', inputs: { mix_id: mix.id, profile_id: p.profile_id },
        config: { baseline: 'all', render_groups: true }, injections: [{ group: 'guitars', db: 3, start: 60, end: 120 }] });
      await jobDone(e.job);
      R.exp_id = e.exp_id; R.profile_id = p.profile_id;
    });
    R.pages = {};
    const routes = [`listen/${R.exp_id}`, 'listen', 'dashboard', 'references', 'references/overview', 'profiles', `profiles/${R.profile_id}`,
      'music', 'speech', 'broadcast', 'studies', 'history', 'feedback', 'export', 'settings'];
    for (const r of routes) {
      app.go(r);
      await wait(r.startsWith('listen/') ? 6000 : 2000);
      const txt = document.querySelector('#main').innerText;
      R.pages[r] = txt.includes('This page could not be shown') ? 'FAILED: ' + txt.split('\n').slice(0, 6).join(' | ') : 'ok';
      say(`${r}: ${R.pages[r]}`);
    }
    R.failed_pages = Object.entries(R.pages).filter(([, v]) => v !== 'ok').map(([k]) => k);
    R.page_errors = (await api.get('/api/client-log')).items.filter((x) => x.kind === 'page-error' || x.kind === 'error' || x.kind === 'rejection');
    R.ok = !R.failed_pages.length;
  } catch (e) { R.ok = false; R.error = e.message; say('ERROR ' + e.message); }
  clearInterval(hb);
  R.page_worst_gap_ms = Math.round(maxGap);
  clientLog('uicheck', 'ui check', { results: R });
}
