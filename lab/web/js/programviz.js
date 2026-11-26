// Program Sound Profile visualisation: one recording (a reference or a broadcast) against the
// aggregate of the references - spectrum, every measure with its range, time-varying behaviour,
// stereo image per band. Shared by the Reference Library, Sound Profiles and Broadcast Compare.
import { h, clear, help } from './ui.js';
import { niceTicks } from './charts.js';

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const DOMAINS = [['spectrum', 'Spectral balance'], ['loudness', 'Loudness'], ['dynamics', 'Dynamics'], ['transients', 'Transients'], ['stereo', 'Stereo image']];
export const metricValue = (scalars, key) => { const [d, k] = key.split('.'); return scalars?.[d]?.[k]; };
const fmtHz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(1)}k` : `${Math.round(f)}`);

// Generic canvas chart: x positions (optionally log), shaded bands and lines.
export function bandLineChart({ xs, log = false, bands = [], lines = [], height = 200, unit = 'dB', xFmt = (x) => x, xLabel = '', zero = false, yRange }) {
  const wrap = h('div', { style: { position: 'relative', height: height + 'px' } });
  const cv = h('canvas'); wrap.appendChild(cv);
  const tip = h('div.small', { style: { position: 'absolute', top: '2px', right: '6px', color: 'var(--text-secondary)', pointerEvents: 'none' } });
  wrap.appendChild(tip);
  const draw = () => {
    const W = wrap.clientWidth || 600, H = height, dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const vals = [...bands.flatMap((b) => [...b.lo, ...b.hi]), ...lines.flatMap((l) => l.values)].filter((v) => v != null && isFinite(v));
    let lo = yRange ? yRange[0] : Math.min(...vals), hi = yRange ? yRange[1] : Math.max(...vals);
    if (!isFinite(lo)) { lo = -1; hi = 1; }
    const pad = Math.max(0.5, (hi - lo) * 0.08); lo -= pad; hi += pad;
    const L = 46, Rm = 8, T = 8, B = 20;
    const X = (i) => { const a = log ? Math.log(xs[0]) : xs[0], b = log ? Math.log(xs[xs.length - 1]) : xs[xs.length - 1]; const v = log ? Math.log(xs[i]) : xs[i]; return L + ((v - a) / (b - a || 1)) * (W - L - Rm); };
    const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    g.font = '10px sans-serif'; g.fillStyle = css('--text-tertiary'); g.strokeStyle = css('--border-subtle'); g.lineWidth = 1;
    for (const v of niceTicks(lo, hi, 4)) { const y = Math.round(Y(v)) + 0.5; g.beginPath(); g.moveTo(L, y); g.lineTo(W - Rm, y); g.stroke(); g.fillText(`${v > 0 ? '+' : ''}${v}${unit ? ' ' + unit : ''}`, 2, y + 3); }
    if (zero && lo < 0 && hi > 0) { g.strokeStyle = css('--border-strong'); const y = Math.round(Y(0)) + 0.5; g.beginPath(); g.moveTo(L, y); g.lineTo(W - Rm, y); g.stroke(); }
    const step = Math.max(1, Math.ceil(xs.length / 12));
    xs.forEach((x, i) => { if (i % step === 0) g.fillText(xFmt(x), X(i) - 8, H - 5); });
    if (xLabel) g.fillText(xLabel, W - Rm - g.measureText(xLabel).width, H - 5);
    for (const b of bands) {
      g.fillStyle = b.color; g.beginPath();
      xs.forEach((_, i) => (i ? g.lineTo(X(i), Y(b.hi[i])) : g.moveTo(X(i), Y(b.hi[i]))));
      for (let i = xs.length - 1; i >= 0; i--) g.lineTo(X(i), Y(b.lo[i]));
      g.closePath(); g.fill();
    }
    for (const l of lines) {
      g.strokeStyle = l.color; g.lineWidth = l.width || 1.5; g.setLineDash(l.dash || []); g.globalAlpha = l.alpha ?? 1; g.beginPath();
      let started = false;
      l.values.forEach((v, i) => { if (v == null || !isFinite(v)) { started = false; return; } if (!started) { g.moveTo(X(i), Y(v)); started = true; } else g.lineTo(X(i), Y(v)); });
      g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    }
    cv.onmousemove = (e) => {
      const r = cv.getBoundingClientRect(); const x = e.clientX - r.left;
      let best = 0, bd = 1e9; xs.forEach((_, i) => { const d = Math.abs(X(i) - x); if (d < bd) { bd = d; best = i; } });
      tip.textContent = `${xFmt(xs[best])}${xLabel ? '' : ''}: ` + lines.filter((l) => l.name).map((l) => `${l.name} ${l.values[best] == null ? '–' : (+l.values[best]).toFixed(1)}`).join(' · ');
    };
    cv.onmouseleave = () => { tip.textContent = ''; };
  };
  new ResizeObserver(draw).observe(wrap);
  return wrap;
}

function legendRow(items) {
  return h('div.legend', { style: { margin: '4px 0 2px' } }, items.map(([label, color, kind]) => h('span.row.tight',
    kind === 'band' ? h('span', { style: { width: '16px', height: '9px', background: color, display: 'inline-block', borderRadius: '2px' } })
      : h('span', { style: { width: '16px', height: '2px', background: color, display: 'inline-block', borderTop: kind === 'dash' ? `2px dashed ${color}` : 'none' } }),
    label)));
}

// One measure: dots for every reference, box p25-p75, whiskers p10-p90, the selected value highlighted.
function metricStrip(key, meta, refs, sel, selLabel, onSelect, finding) {
  const s = meta.stats;
  const values = refs.map((r) => ({ r, v: metricValue(r.scalars, key) })).filter((x) => x.v != null);
  const sv = sel ? metricValue(sel.scalars, key) : null;
  const all = [...values.map((x) => x.v), s?.p10, s?.p90, sv].filter((v) => v != null && isFinite(v));
  if (!all.length) return null;
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = Math.max((hi - lo) * 0.12, 0.05 * Math.max(1, Math.abs(hi))); lo -= pad; hi += pad;
  const x = (v) => `${((v - lo) / (hi - lo)) * 100}%`;
  const track = h('div', { style: { position: 'relative', height: '22px', background: 'var(--surface-well)', borderRadius: '3px' } });
  const add = (st, attrs = {}) => track.appendChild(h('div', { ...attrs, style: { position: 'absolute', ...st } }));
  if (s && s.p10 != null) {
    add({ left: x(s.p10), width: `calc(${x(s.p90)} - ${x(s.p10)})`, top: '10px', height: '2px', background: 'var(--border-strong)' });
    add({ left: x(s.p25), width: `calc(${x(s.p75)} - ${x(s.p25)})`, top: '5px', height: '12px', background: 'var(--accent-muted)', borderRadius: '2px' });
    add({ left: x(s.median), top: '3px', height: '16px', width: '2px', background: 'var(--accent)' });
  }
  for (const { r, v } of values) {
    const isSel = sel && r.id === sel.id;
    add({ left: `calc(${x(v)} - 3px)`, top: isSel ? '4px' : '8px', width: isSel ? '0' : '6px', height: '6px', borderRadius: '50%', background: '#8fa3b5', opacity: 0.75, cursor: onSelect ? 'pointer' : 'default' },
      { title: `${r.title}: ${v} ${meta.unit}`, onclick: () => onSelect && onSelect(r.id) });
  }
  if (sv != null) add({ left: `calc(${x(sv)} - 5px)`, top: '1px', width: '10px', height: '20px', borderRadius: '3px', background: finding ? 'var(--warn)' : '#f5f7fa', border: '2px solid var(--surface-app)' },
    { title: `${selLabel}: ${sv} ${meta.unit}` });
  const stat = s ? `${s.p10} … ${s.p90}` : '–';
  return h('div', { style: { display: 'grid', gridTemplateColumns: '190px 1fr 92px 110px', gap: '10px', alignItems: 'center', padding: '3px 0' } },
    h('div.small', meta.label, ' ', help(meta.explanation || '')),
    track,
    h('div.small.num', { style: { textAlign: 'right', color: finding ? 'var(--warn)' : '' } }, sv != null ? `${sv} ${meta.unit}` : '–'),
    h('div.small.num.dim', { title: 'References: 10th … 90th percentile' }, stat));
}

export function programView({ profile, refs = [], selected = null, selectedLabel, findings = [], onSelect, title = 'Program Sound Profile' }) {
  const sel = typeof selected === 'string' ? refs.find((r) => r.id === selected) : selected;
  const selLabel = selectedLabel || sel?.title || 'Selected';
  const flagged = new Set(findings.map((f) => f.metric));
  const sp = profile.spectrum, centres = sp.band_centres_hz;
  const sh = sp.shape_dB;
  const specLines = [{ name: 'References (median)', values: sh.median, color: css('--accent'), width: 2 }];
  if (sel?.spectrum_shape) {
    specLines.push({ name: selLabel, values: sel.spectrum_shape, color: '#f5f7fa', width: 2 });
    if (sel.variation_p10) specLines.push({ values: sel.variation_p10, color: '#f5f7fa', width: 1, dash: [3, 3], alpha: 0.5 }, { values: sel.variation_p90, color: '#f5f7fa', width: 1, dash: [3, 3], alpha: 0.5 });
  }
  const others = refs.filter((r) => r.spectrum_shape && (!sel || r.id !== sel.id)).slice(0, 40).map((r) => ({ values: r.spectrum_shape, color: '#8fa3b5', width: 0.8, alpha: 0.25 }));
  const spec = bandLineChart({ xs: centres, log: true, unit: 'dB', xFmt: fmtHz, height: 230,
    bands: [{ lo: sh.p10, hi: sh.p90, color: 'rgba(50,156,255,0.13)' }, { lo: sh.p25, hi: sh.p75, color: 'rgba(50,156,255,0.22)' }],
    lines: [...others, ...specLines] });
  const C = profile.curves || {};
  const curveChart = (key, unit, label, tipText) => {
    const c = C[key];
    if (!c) return null;
    const xs = c.median.map((_, i) => Math.round((i + 0.5) * 100 / c.median.length));
    const lines = [{ name: 'median', values: c.median, color: css('--accent'), width: 2 }];
    if (sel?.curves?.[key]) lines.push({ name: selLabel, values: sel.curves[key], color: '#f5f7fa', width: 1.8 });
    return h('div', h('div.small', h('b', label), ' ', help(tipText)),
      bandLineChart({ xs, unit, height: 130, xFmt: (v) => `${v}%`, bands: [{ lo: c.p10, hi: c.p90, color: 'rgba(50,156,255,0.12)' }, { lo: c.p25, hi: c.p75, color: 'rgba(50,156,255,0.2)' }], lines }));
  };
  const sb = profile.stereo_bands;
  const stereo = sb?.sideToMid_dB ? bandLineChart({ xs: sb.band_centres_hz, log: true, unit: 'dB', xFmt: fmtHz, height: 150,
    bands: [{ lo: sb.sideToMid_dB.p10, hi: sb.sideToMid_dB.p90, color: 'rgba(50,156,255,0.13)' }],
    lines: [{ name: 'median', values: sb.sideToMid_dB.median, color: css('--accent'), width: 2 }, ...(sel?.stereo_bands ? [{ name: selLabel, values: sel.stereo_bands, color: '#f5f7fa', width: 1.8 }] : [])] }) : null;
  const strips = DOMAINS.map(([d, label]) => {
    const rows = Object.entries(profile.metrics).filter(([, m]) => m.domain === d).map(([k, m]) => metricStrip(k, m, refs, sel, selLabel, onSelect, flagged.has(k))).filter(Boolean);
    return rows.length ? h('div', h('h3', label), rows) : null;
  });
  return h('div.stack',
    h('div.panel', h('div.ph', h('h2', 'Spectral balance'), h('div.grow'), h('span.small.dim', `${profile.n_references} reference(s) · third-octave shape, overall level removed`)),
      h('div.pb', legendRow([['References p10–p90', 'rgba(50,156,255,0.25)', 'band'], ['p25–p75', 'rgba(50,156,255,0.45)', 'band'], ['median', css('--accent')],
        ...(sel ? [[selLabel, '#f5f7fa'], [`${selLabel}: variation over time (p10/p90)`, '#f5f7fa', 'dash']] : []), ...(others.length ? [['individual references', '#8fa3b588']] : [])]), spec)),
    h('div.panel', h('div.ph', h('h2', 'Measures'), h('div.grow'), legendRow([['references', '#8fa3b5'], ['typical range p25–p75 / p10–p90', 'rgba(50,156,255,0.45)', 'band'], [selLabel, '#f5f7fa']])),
      h('div.pb', strips, profile.n_references < 3 ? h('p.faint.small', 'Fewer than 3 references: ranges are indicative only.') : null)),
    h('div.grid.g2',
      h('div.panel', h('div.ph', h('h2', 'Behaviour over time')), h('div.pb.stack',
        h('p.faint.small', 'Each recording divided into 50 equal parts (0 % = start, 100 % = end); bands show how the references vary.'),
        curveChart('shortterm_rel_LU', 'LU', 'Short-term loudness relative to the whole', 'Where the recording gets louder or quieter relative to its own integrated loudness (build-ups, bridges, endings).'),
        curveChart('tilt_dB_per_oct', 'dB/oct', 'Spectral tilt', 'Brightness over time: higher = brighter.'),
        curveChart('sideToMid_dB', 'dB', 'Stereo width', 'Side/mid energy over time: higher = wider.'),
        curveChart('blockCrest_dB', 'dB', 'Block crest', 'Transient punch over time.'))),
      h('div.panel', h('div.ph', h('h2', 'Stereo width per band')), h('div.pb.stack',
        h('p.faint.small', 'Side energy relative to mid energy in each octave band. Very low = mono in that range (typical for low end).'), stereo))),
    h('p.faint.small', ...(profile.notes || []).map((n) => n + ' ')));
}
