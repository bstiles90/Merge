// Selected-channel panel: one signal stage at a time (IN · EQ · DYN · FX · SENDS · ASSIGN),
// with big direct controls: an EQ graph you drag, a dynamics transfer curve with live GR.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useConsole } from '../core/store';
import { linkInfo } from '../core/links';
import type { Channel, EqBand } from '../core/types';
import { fmtDb, fmtHz, fmtMs, Knob, Toggle } from './controls';
import { ColorPicker, Inserts, LinkSection, SourcePicker } from './Detail';
import { registerMeter } from './meterLoop';

type Tab = 'in' | 'eq' | 'dyn' | 'fx' | 'sends' | 'assign';
let lastTab: Tab = 'in'; // remembered while moving between channels

const BAND_COLORS = ['#e5484d', '#ffc53d', '#46a758', '#0090ff'];
const BAND_NAMES = ['LOW', 'LO-MID', 'HI-MID', 'HIGH'];

// ------------------------------------------------------------------ drag number
/** A value you drag up/down (shift = fine) or double-click to type (e.g. "2.5k"). */
export function DragNumber({
  value,
  min,
  max,
  log,
  step = 0.1,
  format,
  onChange,
  title,
}: {
  value: number;
  min: number;
  max: number;
  log?: boolean;
  step?: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  title?: string;
}) {
  const drag = useRef<{ y: number; v: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  if (editing)
    return (
      <input
        className="dragnum-edit"
        autoFocus
        defaultValue={format(value).replace(/[^\d.\-k]/g, '')}
        onBlur={(e) => {
          setEditing(false);
          const t = e.target.value.trim().toLowerCase();
          const n = t.endsWith('k') ? parseFloat(t) * 1000 : parseFloat(t);
          if (isFinite(n)) onChange(clamp(n));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  return (
    <span
      className="dragnum"
      title={title ?? 'Drag up/down (shift = fine), double-click to type'}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, v: value };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const dy = drag.current.y - e.clientY;
        const k = e.shiftKey ? 0.2 : 1;
        if (log) onChange(clamp(drag.current.v * Math.pow(2, (dy * k) / 60)));
        else onChange(clamp(Math.round((drag.current.v + dy * k * step) / step) * step));
      }}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={() => setEditing(true)}
    >
      {format(value)}
    </span>
  );
}

// ------------------------------------------------------------------ EQ graph
const W = 360, H = 190, GMAX = 18;
const fx = (f: number) => (Math.log(f / 20) / Math.log(1000)) * W;
const xf = (x: number) => 20 * Math.pow(1000, Math.max(0, Math.min(W, x)) / W);
const gy = (g: number) => H / 2 - (g / GMAX) * (H / 2 - 10);
const yg = (y: number) => ((H / 2 - y) / (H / 2 - 10)) * GMAX;
const offline = typeof OfflineAudioContext !== 'undefined' ? new OfflineAudioContext(1, 128, 48000) : null;
const NF = 220;
const freqs = new Float32Array(NF).map((_, i) => 20 * Math.pow(1000, i / (NF - 1)));

function response(type: BiquadFilterType, f: number, g: number, q: number): Float32Array {
  const out = new Float32Array(NF);
  if (!offline) return out;
  const bq = offline.createBiquadFilter();
  bq.type = type;
  bq.frequency.value = f;
  bq.gain.value = g;
  bq.Q.value = q;
  const mag = new Float32Array(NF), ph = new Float32Array(NF);
  bq.getFrequencyResponse(freqs, mag, ph);
  for (let i = 0; i < NF; i++) out[i] = 20 * Math.log10(Math.max(1e-6, mag[i]));
  return out;
}

function EqGraph({ ch, active, setActive }: { ch: Channel; active: number; setActive: (i: number) => void }) {
  const s = useConsole();
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null); // band index, 4 = HPF
  const setBand = (i: number, p: Partial<EqBand>) =>
    s.updateChannel(ch.id, { eq: { ...ch.eq, bands: ch.eq.bands.map((b, j) => (j === i ? { ...b, ...p } : b)) } });

  const curves = useMemo(() => ch.eq.bands.map((b) => response(b.type, b.freq, b.gainDb, b.q)), [ch.eq.bands]);
  const hpfCurve = useMemo(() => response('highpass', ch.hpf.freq, 0, 0.707), [ch.hpf.freq]);
  const total = useMemo(() => {
    const t = new Float32Array(NF);
    if (ch.eq.on) curves.forEach((c) => c.forEach((v, i) => (t[i] += v)));
    if (ch.hpf.on) hpfCurve.forEach((v, i) => (t[i] += v));
    return t;
  }, [curves, hpfCurve, ch.eq.on, ch.hpf.on]);

  const path = (arr: Float32Array) =>
    Array.from(arr, (v, i) => `${i ? 'L' : 'M'}${((i / (NF - 1)) * W).toFixed(1)},${gy(Math.max(-GMAX - 2, Math.min(GMAX + 2, v))).toFixed(1)}`).join('');

  const toLocal = (e: React.PointerEvent | React.WheelEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current === null) return;
    const { x, y } = toLocal(e);
    if (drag.current === 4) {
      s.updateChannel(ch.id, { hpf: { on: true, freq: Math.round(Math.min(600, Math.max(20, xf(x)))) } });
      return;
    }
    const g = Math.max(-15, Math.min(15, yg(y)));
    setBand(drag.current, { freq: Math.round(Math.min(20000, Math.max(20, xf(x)))), gainDb: Math.round(g * 10) / 10 });
    if (!ch.eq.on) s.updateChannel(ch.id, { eq: { ...ch.eq, on: true } });
  };
  const handle = (i: number) => {
    const isHpf = i === 4;
    const b = ch.eq.bands[i];
    const cx = fx(isHpf ? ch.hpf.freq : b.freq);
    const cy = isHpf ? gy(-3) : gy(b.gainDb);
    const on = isHpf ? ch.hpf.on : ch.eq.on;
    return (
      <g
        key={i}
        className={'eq-handle' + (active === i ? ' active' : '') + (on ? '' : ' off')}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          drag.current = i;
          setActive(i);
        }}
        onWheel={(e) => {
          if (isHpf) return;
          const q = Math.min(10, Math.max(0.2, b.q * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
          setBand(i, { q: Math.round(q * 100) / 100 });
        }}
        onDoubleClick={() => (isHpf ? s.updateChannel(ch.id, { hpf: { ...ch.hpf, on: !ch.hpf.on } }) : setBand(i, { gainDb: 0 }))}
      >
        <circle cx={cx} cy={cy} r={9} fill={isHpf ? '#c9ccd1' : BAND_COLORS[i]} />
        <text x={cx} y={cy + 3.5} textAnchor="middle">{isHpf ? 'H' : i + 1}</text>
      </g>
    );
  };

  return (
    <svg
      ref={svg}
      className="eq-graph"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      onPointerMove={onMove}
      onPointerUp={() => (drag.current = null)}
    >
      {[50, 100, 200, 500, 1000, 2000, 5000, 10000].map((f) => (
        <g key={f}>
          <line x1={fx(f)} x2={fx(f)} y1={0} y2={H} className="eq-grid" />
          <text x={fx(f) + 2} y={H - 3} className="eq-axis">{f >= 1000 ? `${f / 1000}k` : f}</text>
        </g>
      ))}
      {[-12, -6, 6, 12].map((g) => (
        <g key={g}>
          <line x1={0} x2={W} y1={gy(g)} y2={gy(g)} className="eq-grid" />
          <text x={3} y={gy(g) - 2} className="eq-axis">{g > 0 ? `+${g}` : g}</text>
        </g>
      ))}
      <line x1={0} x2={W} y1={gy(0)} y2={gy(0)} className="eq-zero" />
      {ch.eq.on && curves.map((c, i) => <path key={i} d={path(c)} className="eq-band-curve" style={{ stroke: BAND_COLORS[i] }} />)}
      <path d={`${path(total)}L${W},${H}L0,${H}Z`} className="eq-fill" />
      <path d={path(total)} className={'eq-total' + (ch.eq.on || ch.hpf.on ? '' : ' off')} />
      {[4, 0, 1, 2, 3].map(handle)}
    </svg>
  );
}

function EqTab({ ch }: { ch: Channel }) {
  const s = useConsole();
  const [active, setActive] = useState(1);
  const up = (p: Partial<Channel>) => s.updateChannel(ch.id, p);
  const setBand = (i: number, p: Partial<EqBand>) => up({ eq: { ...ch.eq, bands: ch.eq.bands.map((b, j) => (j === i ? { ...b, ...p } : b)) } });
  return (
    <div className="tab-body">
      <div className="row between">
        <div className="row">
          <Toggle small on={ch.eq.on} onClick={() => up({ eq: { ...ch.eq, on: !ch.eq.on } })}>EQ</Toggle>
          <Toggle small on={ch.hpf.on} onClick={() => up({ hpf: { ...ch.hpf, on: !ch.hpf.on } })}>HPF</Toggle>
        </div>
        <button className="link-btn" onClick={() => up({ eq: { ...ch.eq, bands: ch.eq.bands.map((b) => ({ ...b, gainDb: 0 })) } })}>flat</button>
      </div>
      <EqGraph ch={ch} active={active} setActive={setActive} />
      <p className="hint">Drag a handle: frequency ↔, gain ↕. Scroll on it for Q. Double-click: reset gain (HPF: on/off).</p>
      <table className="eq-table">
        <thead>
          <tr>
            <th />
            <th>Type</th>
            <th>Freq</th>
            <th>Gain</th>
            <th>Q</th>
          </tr>
        </thead>
        <tbody>
          <tr className={active === 4 ? 'active' : ''} onClick={() => setActive(4)}>
            <td><span className="band-dot" style={{ background: '#c9ccd1' }}>H</span></td>
            <td className="hint">High-pass</td>
            <td><DragNumber value={ch.hpf.freq} min={20} max={600} log format={(v) => `${fmtHz(v)} Hz`} onChange={(freq) => up({ hpf: { on: true, freq: Math.round(freq) } })} /></td>
            <td className="hint">12 dB/oct</td>
            <td />
          </tr>
          {ch.eq.bands.map((b, i) => (
            <tr key={i} className={active === i ? 'active' : ''} onClick={() => setActive(i)}>
              <td><span className="band-dot" style={{ background: BAND_COLORS[i] }}>{i + 1}</span></td>
              <td>
                <select value={b.type} onChange={(e) => setBand(i, { type: e.target.value as EqBand['type'] })} title={BAND_NAMES[i]}>
                  <option value="lowshelf">Low shelf</option>
                  <option value="peaking">Peak</option>
                  <option value="highshelf">High shelf</option>
                </select>
              </td>
              <td><DragNumber value={b.freq} min={20} max={20000} log format={(v) => `${fmtHz(v)} Hz`} onChange={(freq) => setBand(i, { freq: Math.round(freq) })} /></td>
              <td><DragNumber value={b.gainDb} min={-15} max={15} step={0.1} format={(v) => `${fmtDb(v)} dB`} onChange={(gainDb) => setBand(i, { gainDb })} /></td>
              <td><DragNumber value={b.q} min={0.2} max={10} log format={(v) => v.toFixed(2)} onChange={(q) => setBand(i, { q: Math.round(q * 100) / 100 })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ dynamics
function TransferCurve({ comp }: { comp: Channel['comp'] }) {
  const size = 150;
  const toX = (db: number) => ((db + 60) / 60) * size;
  const toY = (db: number) => size - ((db + 60) / 60) * size;
  const out = (x: number) => {
    const over = x - comp.threshold;
    const slope = 1 - 1 / comp.ratio;
    let gr = 0;
    if (over > 3) gr = over * slope;
    else if (over > -3) gr = (slope * (over + 3) * (over + 3)) / 12;
    return x - gr + comp.makeupDb;
  };
  const pts = Array.from({ length: 61 }, (_, i) => {
    const x = -60 + i;
    return `${i ? 'L' : 'M'}${toX(x).toFixed(1)},${toY(Math.min(0, out(x))).toFixed(1)}`;
  }).join('');
  return (
    <svg className="dyn-graph" viewBox={`0 0 ${size} ${size}`}>
      {[-48, -36, -24, -12].map((d) => (
        <g key={d}>
          <line x1={toX(d)} x2={toX(d)} y1={0} y2={size} className="eq-grid" />
          <line x1={0} x2={size} y1={toY(d)} y2={toY(d)} className="eq-grid" />
        </g>
      ))}
      <line x1={0} y1={size} x2={size} y2={0} className="eq-zero" />
      <line x1={toX(comp.threshold)} x2={toX(comp.threshold)} y1={0} y2={size} className="dyn-thresh" />
      <path d={pts} className={'dyn-curve' + (comp.on ? '' : ' off')} />
      <text x={4} y={12} className="eq-axis">out</text>
      <text x={size - 16} y={size - 4} className="eq-axis">in</text>
    </svg>
  );
}

function GrMeter({ id }: { id: string }) {
  const bar = useRef<HTMLDivElement>(null);
  const txt = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      registerMeter(id, (m) => {
        const gr = Math.min(20, Math.max(0, -(m?.gr ?? 0)));
        if (bar.current) bar.current.style.height = `${(gr / 20) * 100}%`;
        if (txt.current) txt.current.textContent = gr > 0.1 ? `-${gr.toFixed(1)}` : '0.0';
      }),
    [id],
  );
  return (
    <div className="gr-meter" title="Gain reduction (dB)">
      <div className="gr-track"><div ref={bar} className="gr-fill" /></div>
      <span ref={txt} className="gr-val">0.0</span>
      <span className="hint">GR</span>
    </div>
  );
}

function DynTab({ ch }: { ch: Channel }) {
  const s = useConsole();
  const up = (p: Partial<Channel>) => s.updateChannel(ch.id, p);
  const g = ch.gate, c = ch.comp;
  return (
    <div className="tab-body">
      <div className="dyn-block">
        <div className="row between">
          <Toggle small on={c.on} onClick={() => up({ comp: { ...c, on: !c.on } })}>COMPRESSOR</Toggle>
          <span className="hint">{c.ratio.toFixed(1)}:1 above {c.threshold.toFixed(0)} dB</span>
        </div>
        <div className="row dyn-top">
          <TransferCurve comp={c} />
          <GrMeter id={ch.id} />
        </div>
        <div className="knob-row">
          <Knob size={40} label="Thresh" value={c.threshold} min={-60} max={0} defaultValue={-18} format={fmtDb} onChange={(threshold) => up({ comp: { ...c, threshold } })} color="#f76b15" />
          <Knob size={40} label="Ratio" value={c.ratio} min={1} max={20} log defaultValue={3} format={(v) => `${v.toFixed(1)}:1`} onChange={(ratio) => up({ comp: { ...c, ratio } })} color="#f76b15" />
          <Knob size={40} label="Attack" value={c.attack} min={0.5} max={200} log defaultValue={10} format={fmtMs} onChange={(attack) => up({ comp: { ...c, attack } })} color="#f76b15" />
          <Knob size={40} label="Release" value={c.release} min={10} max={1000} log defaultValue={120} format={fmtMs} onChange={(release) => up({ comp: { ...c, release } })} color="#f76b15" />
          <Knob size={40} label="Makeup" value={c.makeupDb} min={0} max={24} defaultValue={0} format={fmtDb} onChange={(makeupDb) => up({ comp: { ...c, makeupDb } })} color="#f76b15" />
        </div>
      </div>
      <div className="dyn-block">
        <div className="row between">
          <Toggle small on={g.on} onClick={() => up({ gate: { ...g, on: !g.on } })}>GATE</Toggle>
          <span className="hint">closes {g.rangeDb.toFixed(0)} dB below {g.threshold.toFixed(0)} dB</span>
        </div>
        <div className="knob-row">
          <Knob size={40} label="Thresh" value={g.threshold} min={-80} max={0} defaultValue={-50} format={fmtDb} onChange={(threshold) => up({ gate: { ...g, threshold } })} color="#46a758" />
          <Knob size={40} label="Range" value={g.rangeDb} min={0} max={80} defaultValue={40} format={fmtDb} onChange={(rangeDb) => up({ gate: { ...g, rangeDb } })} color="#46a758" />
          <Knob size={40} label="Attack" value={g.attack} min={0.05} max={50} log defaultValue={1} format={fmtMs} onChange={(attack) => up({ gate: { ...g, attack } })} color="#46a758" />
          <Knob size={40} label="Release" value={g.release} min={10} max={2000} log defaultValue={150} format={fmtMs} onChange={(release) => up({ gate: { ...g, release } })} color="#46a758" />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ other tabs
function InTab({ ch }: { ch: Channel }) {
  const s = useConsole();
  const up = (p: Partial<Channel>) => s.updateChannel(ch.id, p);
  return (
    <div className="tab-body">
      <div className="section-title">Source</div>
      <SourcePicker ch={ch} />
      <div className="in-row">
        <Knob size={56} label="Gain" value={ch.gainDb} min={-24} max={48} defaultValue={0} format={fmtDb} onChange={(gainDb) => up({ gainDb })} />
        <Knob size={40} label="Delay" value={ch.delayMs} min={0} max={500} defaultValue={0} format={fmtMs} onChange={(delayMs) => up({ delayMs })} />
        <Knob size={40} label="HPF" value={ch.hpf.freq} min={20} max={600} log defaultValue={80} format={fmtHz} onChange={(freq) => up({ hpf: { ...ch.hpf, freq } })} color={ch.hpf.on ? '#4aa3ff' : '#555'} />
        <div className="col">
          <Toggle on={ch.phaseInvert} onClick={() => up({ phaseInvert: !ch.phaseInvert })} small title="Polarity invert">Ø</Toggle>
          <Toggle on={ch.hpf.on} onClick={() => up({ hpf: { ...ch.hpf, on: !ch.hpf.on } })} small>HPF</Toggle>
        </div>
      </div>
      <div className="row wrap">
        <Toggle on={ch.inputMode === 'playback'} onClick={() => up({ inputMode: ch.inputMode === 'live' ? 'playback' : 'live' })} small title="Virtual soundcheck: feed this channel from its recorded track">
          {ch.inputMode === 'live' ? 'LIVE INPUT' : 'PLAYBACK'}
        </Toggle>
        <Toggle kind="rec" on={ch.recArm} onClick={() => up({ recArm: !ch.recArm })} small>REC ARM</Toggle>
        <Toggle kind="safe" on={ch.recallSafe} onClick={() => up({ recallSafe: !ch.recallSafe })} small title="Scenes won't change this channel">RECALL SAFE</Toggle>
      </div>
      <LinkSection ch={ch} />
    </div>
  );
}

function SendsTab({ ch }: { ch: Channel }) {
  const s = useConsole();
  const up = (p: Partial<Channel>) => s.updateChannel(ch.id, p);
  return (
    <div className="tab-body">
      <div className="sends sends-big">
        {s.buses.map((b) => {
          if (b.type === 'mixminus') {
            const included = ch.mainAssign && b.mixMinusExclude !== ch.id;
            return (
              <div key={b.id} className="send mm">
                <span className="send-name">{b.name}</span>
                <span className="hint">{included ? 'mix-minus: auto (from main)' : 'excluded from this mix-minus'}</span>
              </div>
            );
          }
          const snd = ch.sends[b.id] ?? { on: false, levelDb: -Infinity, pre: false };
          const setSend = (p: Partial<typeof snd>) => up({ sends: { ...ch.sends, [b.id]: { ...snd, ...p } } });
          return (
            <div key={b.id} className={'send' + (snd.on ? ' on' : '')}>
              <Toggle small on={snd.on} onClick={() => setSend({ on: !snd.on, levelDb: isFinite(snd.levelDb) ? snd.levelDb : 0 })}>{b.name}</Toggle>
              <input type="range" min={-60} max={10} step={0.5} value={isFinite(snd.levelDb) ? snd.levelDb : -60} onChange={(e) => setSend({ levelDb: Number(e.target.value) <= -60 ? -Infinity : Number(e.target.value), on: true })} />
              <span className="send-db">{isFinite(snd.levelDb) ? fmtDb(snd.levelDb) : '-∞'}</span>
              <Toggle small on={snd.pre} onClick={() => setSend({ pre: !snd.pre })} title="Pre-fader (e.g. IEM / foldback)">PRE</Toggle>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AssignTab({ ch }: { ch: Channel }) {
  const s = useConsole();
  const up = (p: Partial<Channel>) => s.updateChannel(ch.id, p);
  return (
    <div className="tab-body">
      <div className="section-title">Output</div>
      <div className="row">
        <Toggle on={ch.mainAssign} onClick={() => up({ mainAssign: !ch.mainAssign })}>MAIN LR</Toggle>
      </div>
      <div className="section-title">DCAs</div>
      <div className="chips">
        {s.dcas.map((d) => (
          <button key={d.id} className={'chip' + (ch.dcas.includes(d.id) ? ' on' : '')} style={ch.dcas.includes(d.id) ? { background: d.color } : undefined} onClick={() => up({ dcas: ch.dcas.includes(d.id) ? ch.dcas.filter((x) => x !== d.id) : [...ch.dcas, d.id] })}>
            {d.name}
          </button>
        ))}
      </div>
      <div className="section-title">Mute groups</div>
      <div className="chips">
        {s.muteGroups.map((g) => (
          <button key={g.id} className={'chip mg' + (ch.muteGroups.includes(g.id) ? ' on' : '')} onClick={() => up({ muteGroups: ch.muteGroups.includes(g.id) ? ch.muteGroups.filter((x) => x !== g.id) : [...ch.muteGroups, g.id] })}>
            {g.name}
          </button>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the panel
export function ChannelPanel({ ch }: { ch: Channel }) {
  const s = useConsole();
  const [tab, setTabState] = useState<Tab>(lastTab);
  const setTab = (t: Tab) => {
    lastTab = t;
    setTabState(t);
  };
  const link = linkInfo(s, ch.id);
  const eqActive = ch.eq.on && ch.eq.bands.some((b) => Math.abs(b.gainDb) > 0.05);
  const sendCount = Object.values(ch.sends).filter((x) => x.on).length;
  const tabs: [Tab, string, boolean | string][] = [
    ['in', 'IN', ch.hpf.on || ch.gainDb !== 0],
    ['eq', 'EQ', eqActive],
    ['dyn', 'DYN', ch.comp.on || ch.gate.on],
    ['fx', 'FX', ch.inserts.length ? String(ch.inserts.length) : false],
    ['sends', 'SENDS', sendCount ? String(sendCount) : false],
    ['assign', 'ASSIGN', false],
  ];
  return (
    <div className="detail chpanel">
      <div className="chp-head" style={{ borderColor: ch.color }}>
        <span className="chp-num" style={{ background: ch.color }}>{ch.id.replace('ch', '')}</span>
        <input className="name-input" value={ch.name} onChange={(e) => s.updateChannel(ch.id, { name: e.target.value })} />
        {link && <span className="hint">stereo {link.side} ↔ {s.channels.find((c) => c.id === link.partner)?.name}</span>}
      </div>
      <ColorPicker value={ch.color} onChange={(color) => s.updateChannel(ch.id, { color })} />
      <div className="chp-tabs">
        {tabs.map(([id, label, badge]) => (
          <button key={id} className={'chp-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>
            {label}
            {badge && <span className={'chp-badge' + (typeof badge === 'string' ? ' count' : '')}>{typeof badge === 'string' ? badge : ''}</span>}
          </button>
        ))}
      </div>
      <div className="chp-content">
        {tab === 'in' && <InTab ch={ch} />}
        {tab === 'eq' && <EqTab ch={ch} />}
        {tab === 'dyn' && <DynTab ch={ch} />}
        {tab === 'fx' && (
          <div className="tab-body">
            <Inserts inserts={ch.inserts} onChange={(inserts) => s.updateChannel(ch.id, { inserts })} />
          </div>
        )}
        {tab === 'sends' && <SendsTab ch={ch} />}
        {tab === 'assign' && <AssignTab ch={ch} />}
      </div>
    </div>
  );
}
