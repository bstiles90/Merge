// Canvas charts: waveform overview, time series (offsets, activity, speech), profile ranges.
import { h, fmtTime, groupColor } from './ui.js';

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// A time-axis canvas: click to seek, drag to select a region, playhead, markers and regions.
export class TimeCanvas {
  constructor({ height = 90, duration = 1, draw, onSeek, onSelect, onHover, markers = [], regions = [], selectable = true }) {
    this.el = h('div.wave', { style: { height: height + 'px' } });
    this.cv = h('canvas'); this.el.appendChild(this.cv);
    this.ov = h('canvas', { style: { position: 'absolute', left: 0, top: 0, pointerEvents: 'none' } }); this.el.appendChild(this.ov);
    this.tip = h('div', { style: { position: 'absolute', top: '2px', left: 0, pointerEvents: 'none', font: '11px var(--font-mono)', color: 'var(--text-secondary)',
      background: 'rgba(11,13,15,.85)', padding: '0 4px', borderRadius: '3px', display: 'none' } });
    this.el.appendChild(this.tip);
    Object.assign(this, { height, duration, drawFn: draw, onSeek, onSelect, onHover, markers, regions, selectable, playhead: 0, sel: null, view: [0, duration] });
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(this.el);
    let down = null;
    this.cv.addEventListener('mousedown', (e) => { down = { x: e.offsetX, t: this.xToT(e.offsetX) }; });
    window.addEventListener('mousemove', (e) => {
      if (!down) return;
      const r = this.cv.getBoundingClientRect(); const x = e.clientX - r.left;
      if (this.selectable && Math.abs(x - down.x) > 4) { const t = this.xToT(x); this.sel = [Math.min(down.t, t), Math.max(down.t, t)]; this.render(); }
    });
    window.addEventListener('mouseup', (e) => {
      if (!down) return;
      const r = this.cv.getBoundingClientRect(); const x = e.clientX - r.left;
      if (this.selectable && Math.abs(x - down.x) > 4) { this.onSelect && this.onSelect(this.sel); }
      else {
        const m = this.markerAt(x);
        if (m && m.onclick) m.onclick(m); else this.onSeek && this.onSeek(this.xToT(x));
      }
      down = null;
    });
    this.cv.addEventListener('mousemove', (e) => {
      const t = this.xToT(e.offsetX), m = this.markerAt(e.offsetX);
      this.tip.style.display = 'block';
      this.tip.textContent = m && m.label ? `${fmtTime(m.t, true)}  ${m.label}` : fmtTime(t, true);
      this.tip.style.left = Math.min(e.offsetX + 8, this.w - 160) + 'px';
      this.cv.style.cursor = m && m.onclick ? 'pointer' : 'crosshair';
      this.onHover && this.onHover(t);
    });
    this.cv.addEventListener('mouseleave', () => { this.tip.style.display = 'none'; });
  }
  markerAt(x) {
    let best = null, bd = 6;
    for (const m of this.markers) { const d = Math.abs(this.tToX(m.t) - x); if (d < bd) { bd = d; best = m; } }
    return best;
  }
  resize() {
    const r = this.el.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(50, r.width); this.hgt = this.height;
    for (const c of [this.cv, this.ov]) { c.width = this.w * dpr; c.height = this.hgt * dpr; c.style.width = this.w + 'px'; c.style.height = this.hgt + 'px'; }
    this.g = this.cv.getContext('2d'); this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.go = this.ov.getContext('2d'); this.go.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }
  tToX(t) { return ((t - this.view[0]) / (this.view[1] - this.view[0] || 1)) * this.w; }
  xToT(x) { return Math.max(0, Math.min(this.duration, this.view[0] + (x / this.w) * (this.view[1] - this.view[0]))); }
  setDuration(d) { this.duration = d; this.view = [0, d]; this.render(); }
  setPlayhead(t) { this.playhead = t; this.renderOverlay(); }
  render() {
    if (!this.g) return;
    const g = this.g; g.clearRect(0, 0, this.w, this.hgt);
    for (const r of this.regions) {
      g.fillStyle = r.color || 'rgba(50,156,255,0.10)';
      const x0 = this.tToX(r.a), x1 = this.tToX(r.b);
      g.fillRect(x0, 0, x1 - x0, this.hgt);
      if (r.label) { g.fillStyle = r.text || css('--text-secondary'); g.font = '10px sans-serif'; g.fillText(r.label, x0 + 3, this.hgt - 4); }
    }
    this.drawFn && this.drawFn(g, this);
    if (this.sel) {
      const x0 = this.tToX(this.sel[0]), x1 = this.tToX(this.sel[1]);
      g.fillStyle = 'rgba(50,156,255,0.18)'; g.fillRect(x0, 0, x1 - x0, this.hgt);
      g.strokeStyle = css('--accent'); g.lineWidth = 1; g.strokeRect(x0 + 0.5, 0.5, x1 - x0 - 1, this.hgt - 1);
    }
    for (const m of this.markers) {
      const x = Math.round(this.tToX(m.t)) + 0.5;
      g.strokeStyle = m.color || css('--warn'); g.lineWidth = m.width || 1; g.globalAlpha = m.alpha ?? 0.9;
      g.beginPath(); g.moveTo(x, m.top ?? 0); g.lineTo(x, this.hgt); g.stroke();
      if (m.flag) { g.fillStyle = m.color || css('--warn'); g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 6, 3); g.lineTo(x, 7); g.fill(); }
      g.globalAlpha = 1;
    }
    this.renderOverlay();
  }
  renderOverlay() {
    if (!this.go) return;
    const g = this.go; g.clearRect(0, 0, this.w, this.hgt);
    const x = Math.round(this.tToX(this.playhead)) + 0.5;
    g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, this.hgt); g.stroke();
  }
}

export function drawPeaks(peaks, color) {
  return (g, tc) => {
    if (!peaks || !peaks.peaks.length) return;
    const p = peaks.peaks, n = p.length, mid = tc.hgt / 2;
    g.fillStyle = color || css('--accent-muted');
    for (let x = 0; x < tc.w; x++) {
      const t0 = tc.xToT(x), t1 = tc.xToT(x + 1);
      const i0 = Math.floor((t0 / peaks.duration_s) * n), i1 = Math.max(i0 + 1, Math.floor((t1 / peaks.duration_s) * n));
      let m = 0; for (let i = i0; i < i1 && i < n; i++) m = Math.max(m, p[i]);
      const hh = Math.max(0.5, Math.sqrt(m) * (mid - 3));
      g.fillRect(x, mid - hh, 1, hh * 2);
    }
  };
}

// Series: {time: [...], lines: [{name, values, color, dash}]}, range [lo, hi], unit
export function drawSeries(series, { lo, hi, unit = 'dB', zero = true, step = false } = {}) {
  return (g, tc) => {
    if (!series) return;
    const y = (v) => tc.hgt - 6 - ((v - lo) / (hi - lo)) * (tc.hgt - 12);
    g.strokeStyle = css('--border-subtle'); g.lineWidth = 1; g.font = '10px sans-serif'; g.fillStyle = css('--text-tertiary');
    const ticks = niceTicks(lo, hi, 4);
    for (const v of ticks) { const yy = Math.round(y(v)) + 0.5; g.beginPath(); g.moveTo(0, yy); g.lineTo(tc.w, yy); g.stroke(); g.fillText(`${v > 0 ? '+' : ''}${v} ${unit}`, 3, yy - 2); }
    if (zero && lo < 0 && hi > 0) { g.strokeStyle = css('--border-strong'); const yy = Math.round(y(0)) + 0.5; g.beginPath(); g.moveTo(0, yy); g.lineTo(tc.w, yy); g.stroke(); }
    const T = series.time;
    for (const L of series.lines) {
      if (L.hidden) continue;
      g.strokeStyle = L.color; g.lineWidth = L.width || 1.6; g.setLineDash(L.dash || []);
      g.beginPath(); let started = false, prevY = null;
      for (let i = 0; i < T.length; i++) {
        const v = L.values[i]; if (v == null || !isFinite(v)) { started = false; continue; }
        const x = tc.tToX(T[i]); if (x < -2 || x > tc.w + 2) { started = false; continue; }
        const yy = y(Math.max(lo, Math.min(hi, v)));
        if (!started) { g.moveTo(x, yy); started = true; } else { if (step && prevY != null) g.lineTo(x, prevY); g.lineTo(x, yy); }
        prevY = yy;
      }
      g.stroke(); g.setLineDash([]);
    }
  };
}

// Activity lanes: one thin lane per group, filled where active
export function drawLanes(time, lanes) {
  return (g, tc) => {
    const n = lanes.length, lh = tc.hgt / n;
    lanes.forEach((L, k) => {
      g.fillStyle = L.color; g.globalAlpha = 0.75;
      let start = null;
      for (let i = 0; i <= time.length; i++) {
        const on = i < time.length && L.values[i] > 0.5;
        if (on && start == null) start = time[i];
        if (!on && start != null) { const x0 = tc.tToX(start), x1 = tc.tToX(time[i - 1] + 0.1); g.fillRect(x0, k * lh + 2, Math.max(1, x1 - x0), lh - 4); start = null; }
      }
      g.globalAlpha = 1; g.font = '10px sans-serif';
      const tw = g.measureText(L.name).width; g.fillStyle = 'rgba(11,13,15,0.8)'; g.fillRect(2, k * lh + 2, tw + 6, lh - 4);
      g.fillStyle = css('--text-secondary'); g.fillText(L.name, 5, k * lh + lh / 2 + 3.5);
    });
  };
}

export function niceTicks(lo, hi, n) {
  const span = hi - lo, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => span / s <= n + 1) || mag * 10;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

export function legend(items, onToggle) {
  return h('div.legend', items.map((it) => h('label', h('input', { type: 'checkbox', checked: !it.hidden, onchange: (e) => onToggle(it, !e.target.checked) }),
    h('span.dot', { style: { background: it.color } }), it.name)));
}

// Horizontal range chart for profile balance targets (p10-p90 whiskers, p25-p75 box, median tick)
export function rangeChart(rows, { lo, hi, unit = 'LU', compare } = {}) {
  const wrap = h('div', { style: { display: 'grid', gridTemplateColumns: '150px 1fr 70px', gap: '2px 10px', alignItems: 'center' } });
  const x = (v) => `${((v - lo) / (hi - lo)) * 100}%`;
  for (const r of rows) {
    const bar = h('div', { style: { position: 'relative', height: '18px', background: 'var(--surface-well)', borderRadius: '3px' } });
    const add = (style) => bar.appendChild(h('div', { style: { position: 'absolute', ...style } }));
    if (lo < 0 && hi > 0) add({ left: x(0), top: 0, bottom: 0, width: '1px', background: 'var(--border-strong)' });
    if (r.p10 != null) add({ left: x(r.p10), width: `calc(${x(r.p90)} - ${x(r.p10)})`, top: '8px', height: '2px', background: 'var(--border-strong)' });
    if (r.p25 != null) add({ left: x(r.p25), width: `calc(${x(r.p75)} - ${x(r.p25)})`, top: '4px', height: '10px', background: 'var(--accent-muted)', borderRadius: '2px' });
    if (r.median != null) add({ left: x(r.median), top: '1px', height: '16px', width: '2px', background: 'var(--accent)' });
    if (compare && r.cmp != null) add({ left: x(r.cmp), top: '1px', height: '16px', width: '2px', background: 'var(--warn)' });
    if (r.live != null) add({ left: x(r.live), top: '2px', height: '14px', width: '3px', background: r.outside ? 'var(--danger)' : 'var(--ok)', borderRadius: '1px' });
    wrap.append(h('div.small', { title: r.title || '' }, r.label), bar, h('div.small.num.dim', r.median != null ? `${r.median.toFixed(1)} ${unit}` : '–'));
  }
  return wrap;
}

// Small bar chart of tonal shape (octave bands)
export function bandChart(bands, series, { lo = -30, hi = 15 } = {}) {
  const W = 360, H = 120;
  const cv = h('canvas', { width: W * 2, height: H * 2, style: { width: W + 'px', height: H + 'px' } });
  const g = cv.getContext('2d'); g.scale(2, 2);
  const x = (i) => 30 + (i / (bands.length - 1)) * (W - 40), y = (v) => H - 16 - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - 24);
  g.strokeStyle = '#2a2f35'; g.fillStyle = '#5d6670'; g.font = '9px sans-serif';
  for (const v of niceTicks(lo, hi, 4)) { g.beginPath(); g.moveTo(30, y(v)); g.lineTo(W - 8, y(v)); g.stroke(); g.fillText(v, 2, y(v) + 3); }
  bands.forEach((b, i) => g.fillText(b >= 1000 ? `${Math.round(b / 1000)}k` : b, x(i) - 8, H - 3));
  for (const s of series) {
    g.strokeStyle = s.color; g.lineWidth = 1.6; g.setLineDash(s.dash || []); g.beginPath();
    s.values.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)))); g.stroke(); g.setLineDash([]);
  }
  return cv;
}

export { groupColor };
