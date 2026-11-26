// Local API client. The launch token arrives in the URL hash (#t=...) and is kept for this window only.
let TOKEN = null;
(function initToken() {
  const m = location.hash.match(/t=([\w-]+)/);
  if (m) {
    TOKEN = m[1];
    try { sessionStorage.setItem('mil-token', TOKEN); } catch (e) {}
    history.replaceState(null, '', location.pathname + (/audiocheck=auto/.test(location.hash) ? '#/audiocheck/auto' : '#/'));
  } else {
    try { TOKEN = sessionStorage.getItem('mil-token'); } catch (e) {}
  }
})();

export class ApiError extends Error {}

async function call(method, path, body) {
  const r = await fetch(path, {
    method, headers: { 'X-Lab-Token': TOKEN || '', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch (e) { data = { error: `Unexpected response (${r.status})` }; }
  if (!r.ok) throw new ApiError(data.error || `Request failed (${r.status})`);
  return data;
}

export const api = {
  get: (p) => call('GET', p),
  post: (p, b = {}) => call('POST', p, b),
  token: () => TOKEN,
  audioUrl(params) {
    const q = new URLSearchParams({ ...params, t: TOKEN || '' });
    return `/api/audio?${q}`;
  },
  peaksUrl(params, n = 2000) {
    const q = new URLSearchParams({ ...params, n, t: TOKEN || '' });
    return `/api/peaks?${q}`;
  },
};

// ---------------------------------------------------------------- jobs
const listeners = new Set();
let jobs = [];
export function onJobs(fn) { listeners.add(fn); fn(jobs); return () => listeners.delete(fn); }
export function currentJobs() { return jobs; }
let polling = null;
export async function pollJobs() {
  try {
    jobs = (await api.get('/api/jobs')).jobs;
    listeners.forEach((f) => f(jobs));
  } catch (e) { /* server restarting */ }
  const active = jobs.some((j) => j.status === 'queued' || j.status === 'running');
  clearTimeout(polling);
  polling = setTimeout(pollJobs, active ? 600 : 3000);
}

export function waitJob(id, onProgress) {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      let j;
      try { j = (await api.get(`/api/jobs/${id}`)).job; } catch (e) { return reject(e); }
      onProgress && onProgress(j);
      if (j.status === 'done') return resolve(j);
      if (j.status === 'error') return reject(new ApiError(j.error || 'The job failed'));
      if (j.status === 'cancelled') return reject(new ApiError('Cancelled'));
      setTimeout(tick, 400);
    };
    pollJobs();
    tick();
  });
}

// ---------------------------------------------------------------- desktop bridge (pywebview)
function bridge() { return window.pywebview && window.pywebview.api; }
export const desktop = {
  available: () => !!bridge(),
  async openAudio(multiple = true) { return bridge() ? (await bridge().open_audio(multiple)) || [] : null; },
  async openFolder() { return bridge() ? await bridge().open_folder() : null; },
  async saveFile(name) { return bridge() ? await bridge().save_file(name) : null; },
};

// ---------------------------------------------------------------- report UI errors to the Lab (diagnostics export)
export function clientLog(kind, message, extra = {}) {
  try { call('POST', '/api/client-log', { kind, message: String(message).slice(0, 2000), userAgent: navigator.userAgent, ...extra }).catch(() => {}); } catch (e) {}
}
window.addEventListener('error', (e) => clientLog('error', e.message, { detail: `${e.filename}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => clientLog('rejection', e.reason && e.reason.message ? e.reason.message : String(e.reason)));
