// Small DOM toolkit: element builder, toasts, modals, formatting, a minimal Markdown renderer.
import { desktop } from './api.js';

export function h(tag, attrs = {}, ...kids) {
  // 'tag.class1.class2#id' (any order after the tag name)
  const parts = tag.match(/^[^.#]*|[.#][^.#]+/g) || [''];
  const el = document.createElement(parts[0] || 'div');
  const cls = parts.slice(1).filter((p) => p[0] === '.').map((p) => p.slice(1));
  const id = parts.slice(1).find((p) => p[0] === '#');
  if (cls.length) el.className = cls.join(' ');
  if (id) el.id = id.slice(1);
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) { kids.unshift(attrs); attrs = {}; }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list' && k !== 'form') { try { el[k] = v; } catch (e) { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export function clear(el, ...kids) { el.replaceChildren(); append(el, kids); return el; }

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- formatting
export function fmtTime(s, ms = false) {
  if (s == null || isNaN(s)) return '–';
  const neg = s < 0; s = Math.abs(s);
  const m = Math.floor(s / 60), sec = s - m * 60;
  const t = `${m}:${(ms ? sec.toFixed(1) : Math.floor(sec).toString()).padStart(ms ? 4 : 2, '0')}`;
  return (neg ? '-' : '') + t;
}
export function fmtDb(v, d = 1, unit = 'dB') { return v == null || isNaN(v) ? '–' : `${v > 0 ? '+' : ''}${(+v).toFixed(d)} ${unit}`; }
export function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}
export function fmtDate(s) {
  if (!s) return '–';
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export const GROUPS = ['vocals', 'drums', 'bass', 'guitars', 'keys'];
export const GROUP_NAMES = { vocals: 'Vocals', drums: 'Drums', bass: 'Bass', guitars: 'Guitars', keys: 'Keys & other', other: 'Other' };
export const groupName = (g) => GROUP_NAMES[g] || g;
export const groupColor = (g) => getComputedStyle(document.documentElement).getPropertyValue(`--g-${g}`).trim() || '#8fa3b5';
export const VERSION_NAMES = {
  before: 'Original', after: 'Adjusted', after_experimental_eq: 'Adjusted + experimental EQ', after_automix: 'Gain sharing only',
};
export const versionName = (v) => VERSION_NAMES[v] || v;

export function badge(text, kind = 'info', tip) { return h('span.badge.b-' + kind, { title: tip || null }, text); }
export function statusBadge(status) {
  const L = { complete: 'Complete', running: 'Running', queued: 'Queued', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' };
  return badge(L[status] || status, status);
}
export function help(tip) { return h('span.help', { 'data-tip': tip, tabIndex: 0 }, '?'); }
export function field(label, input, tip) {
  return h('label.f', h('span', label, tip ? help(tip) : null), input);
}

// ---------------------------------------------------------------- toasts, modals
export function toast(msg, err = false) {
  const box = document.getElementById('toasts');
  const t = h('div.toast' + (err ? '.err' : ''), msg);
  box.appendChild(t);
  setTimeout(() => t.remove(), err ? 7000 : 3500);
}
export function showError(e) { console.error(e); toast(e && e.message ? e.message : String(e), true); }

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const bg = h('div.modal-bg');
  const close = () => { bg.remove(); document.removeEventListener('keydown', key); onClose && onClose(); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  const foot = h('div.mf');
  const m = h('div.modal' + (wide ? '.wide' : ''),
    h('div.mh', h('h2', title), h('button.ghost', { onclick: close, title: 'Close' }, '✕')),
    h('div.mb', body), foot);
  for (const a of actions) {
    foot.appendChild(h('button' + (a.primary ? '.primary' : '') + (a.danger ? '.danger' : ''), {
      onclick: async (e) => {
        if (!a.run) return close();
        e.target.disabled = true;
        try { const r = await a.run(); if (r !== false) close(); } catch (err) { showError(err); }
        e.target.disabled = false;
      },
    }, a.label));
  }
  if (!actions.length) foot.remove();
  bg.appendChild(m);
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  document.addEventListener('keydown', key);
  document.body.appendChild(bg);
  return { close, el: m, body: m.querySelector('.mb') };
}
export function confirmBox(title, text, label = 'Continue', danger = false) {
  return new Promise((res) => {
    let answered = false;
    modal({ title, body: h('p', text), onClose: () => !answered && res(false),
      actions: [{ label: 'Cancel' }, { label, primary: !danger, danger, run: () => { answered = true; res(true); } }] });
  });
}
export function promptBox(title, label, value = '') {
  return new Promise((res) => {
    const inp = h('input', { value, style: { width: '100%' } });
    let done = false;
    const m = modal({ title, body: field(label, inp), onClose: () => !done && res(null),
      actions: [{ label: 'Cancel' }, { label: 'OK', primary: true, run: () => { done = true; res(inp.value.trim()); } }] });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { done = true; res(inp.value.trim()); m.close(); } });
    setTimeout(() => inp.focus(), 30);
  });
}

// File selection: native dialogs in the app; outside the app (developer browser testing)
// a box to paste paths. Drag and drop from Finder is handled globally (window.labDropped).
export async function pickAudio(multiple = true) {
  if (desktop.available()) return await desktop.openAudio(multiple);
  return pastePaths('Choose audio files', 'Paste file or folder paths, one per line');
}
export async function pickFolder() {
  if (desktop.available()) return await desktop.openFolder();
  const r = await pastePaths('Choose a folder', 'Folder path', false);
  return r && r[0];
}
function pastePaths(title, label, multi = true) {
  return new Promise((res) => {
    const ta = h(multi ? 'textarea' : 'input', { style: { width: '100%' }, placeholder: '/Users/you/Music/...' });
    let done = false;
    modal({ title, body: [h('p.dim', 'You are using the Lab outside its own window, so native file dialogs are not available.'), field(label, ta)],
      onClose: () => !done && res(null),
      actions: [{ label: 'Cancel' }, { label: 'Use these', primary: true, run: () => { done = true; res(ta.value.split('\n').map((s) => s.trim()).filter(Boolean)); } }] });
  });
}

// Drag and drop: the current page registers a handler.
let dropHandler = null;
export function setDropHandler(fn) { dropHandler = fn; }
window.labDropped = (paths) => { if (dropHandler) dropHandler(paths); else toast('Open an import screen to drop files.'); };

// ---------------------------------------------------------------- markdown (reports written by the backend)
export function md(src, imgBase) {
  const lines = String(src || '').split('\n');
  let out = '', inList = false, inCode = false, table = [];
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src2) => imgBase ? `<img alt="${alt}" src="${imgBase(src2)}">` : '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r) => r.replace(/^\s*\||\|\s*$/g, '').split('|'));
    out += '<table>' + rows.map((r, i) => '<tr>' + r.map((c) => `<${i ? 'td' : 'th'}>${inline(c.trim())}</${i ? 'td' : 'th'}>`).join('') + '</tr>').join('') + '</table>';
    table = [];
  };
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '');
    if (l.startsWith('```')) { flushTable(); if (inList) { out += '</ul>'; inList = false; } out += inCode ? '</pre>' : '<pre class="prompt">'; inCode = !inCode; continue; }
    if (inCode) { out += esc(raw) + '\n'; continue; }
    if (/^\s*\|/.test(l)) { if (inList) { out += '</ul>'; inList = false; } table.push(l); continue; }
    flushTable();
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { if (inList) { out += '</ul>'; inList = false; } const n = Math.min(4, m[1].length + 1); out += `<h${n}>${inline(m[2])}</h${n}>`; }
    else if ((m = l.match(/^\s*[-*]\s+(.*)/))) { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^>\s?(.*)/))) { out += `<blockquote>${inline(m[1])}</blockquote>`; }
    else if (!l.trim()) { if (inList) { out += '</ul>'; inList = false; } }
    else { if (inList) { out += '</ul>'; inList = false; } out += `<p>${inline(l)}</p>`; }
  }
  flushTable();
  if (inList) out += '</ul>';
  if (inCode) out += '</pre>';
  return h('div.md', { html: out });
}

export function empty(title, text, ...actions) {
  return h('div.empty', h('div.t', title), text ? h('p', text) : null, actions.length ? h('div.row', { style: { justifyContent: 'center', marginTop: '10px' } }, actions) : null);
}
export function panel(title, body, ...headExtras) {
  return h('div.panel', h('div.ph', h('h2', title), h('div.grow'), headExtras), h('div.pb', body));
}
export function pageHead(title, sub, ...actions) {
  return h('div.page-head', h('div.grow', h('h1', title), sub ? h('div.dim', sub) : null), actions);
}
export function select(options, value, onchange, attrs = {}) {
  const s = h('select', { ...attrs, onchange: (e) => onchange && onchange(e.target.value) },
    options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: String(v) === String(value) }, l); }));
  return s;
}
export function seg(options, value, onchange) {
  const box = h('div.seg');
  const render = (cur) => clear(box, options.map(([v, l]) => h('button' + (v === cur ? '.on' : ''), { onclick: () => { render(v); onchange(v); } }, l)));
  render(value);
  return box;
}
