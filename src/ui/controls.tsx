import { useEffect, useRef, useState } from 'react';
import { faderDbToPos, faderPosToDb, formatDb } from '../core/mix';
import { registerMeter } from './meterLoop';
import { useConsole } from '../core/store';

// ------------------------------------------------------------------ Fader
export function Fader({
  db,
  onChange,
  color,
  height = 220,
}: {
  db: number;
  onChange: (db: number) => void;
  color?: string;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = faderDbToPos(db);
  const drag = useRef<{ y: number; pos: number } | null>(null);
  const capHeight = 34;
  const travel = height - capHeight;

  const onPointerDown = (e: React.PointerEvent) => {
    // Only the cap moves the fader (like a real console): clicks elsewhere on the track do nothing,
    // so a stray click can never jump a live fader.
    const rect = ref.current!.getBoundingClientRect();
    const capTop = rect.top + (1 - pos) * travel;
    const onCap = e.clientY >= capTop && e.clientY <= capTop + capHeight;
    if (!onCap) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, pos };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const fine = e.shiftKey ? 0.2 : 1;
    const p = drag.current.pos - ((e.clientY - drag.current.y) / travel) * fine;
    onChange(faderPosToDb(Math.min(1, Math.max(0, p))));
  };
  const end = () => (drag.current = null);

  return (
    <div
      ref={ref}
      className="fader"
      style={{ height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={(e) => {
        const rect = ref.current!.getBoundingClientRect();
        const capTop = rect.top + (1 - pos) * travel;
        if (e.clientY >= capTop && e.clientY <= capTop + capHeight) onChange(0);
      }}
      title={`${formatDb(db)} dB — drag the cap to move, double-click the cap for 0 dB, shift-drag for fine`}
    >
      <div className="fader-slot" />
      {[10, 5, 0, -5, -10, -20, -30, -40, -60].map((m) => (
        <div key={m} className={'fader-tick' + (m === 0 ? ' zero' : '')} style={{ top: (1 - faderDbToPos(m)) * travel + capHeight / 2 }}>
          <span>{m > 0 ? `+${m}` : m}</span>
        </div>
      ))}
      <div className="fader-cap" style={{ top: (1 - pos) * travel, height: capHeight, borderTopColor: color, cursor: 'grab' }} />
    </div>
  );
}

// ------------------------------------------------------------------ Meter
const METER_MIN = -60;
function dbToY(db: number, h: number) {
  const t = Math.max(0, Math.min(1, (db - METER_MIN) / (0 - METER_MIN)));
  // more resolution near the top
  return h - Math.pow(t, 1.6) * h;
}

/** Meter colour zones, console style: green, yellow from the gain-setting point, red near clip. */
export const METER_RED_DB = -3;

/** dBFS marks for a meter (digital full scale, like LV1 / Audition), drawn beside it. */
export const METER_MARKS = [0, -6, -12, -18, -24, -36, -48];
export function MeterScale({ height }: { height: number }) {
  const yellowDb = useConsole((s) => s.meterYellowDb ?? -10);
  return (
    <div className="meter-scale" style={{ height }} title="Meter scale: dBFS (0 = digital full scale)">
      {METER_MARKS.map((db) => (
        <span key={db} className={'ms-mark' + (db === 0 ? ' zero' : '') + (db >= yellowDb ? ' hot' : '')} style={{ top: dbToY(db, height) }}>
          {db === 0 ? '0' : -db}
        </span>
      ))}
    </div>
  );
}

/** Peak level as a number (dBFS, held briefly), coloured by meter zone. Updated straight from
 *  the meter loop (no React renders). */
export function PeakReadout({ id }: { id: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const yellowDb = useConsole((s) => s.meterYellowDb ?? -10);
  useEffect(
    () =>
      registerMeter(id, (m) => {
        const el = ref.current;
        if (!el) return;
        const pk = Math.max(m?.hold ?? -120, m?.holdR ?? -120);
        const txt = pk <= -60 ? '-∞' : pk >= 0 ? (m?.clip ? 'CLIP' : '0.0') : pk.toFixed(1);
        if (el.textContent !== txt) el.textContent = txt;
        const zone = m?.clip ? 'clip' : pk >= METER_RED_DB ? 'red' : pk >= yellowDb ? 'yellow' : pk > -60 ? 'green' : 'off';
        if (el.dataset.zone !== zone) el.dataset.zone = zone;
      }),
    [id, yellowDb],
  );
  return <span ref={ref} className="peak-readout" data-zone="off" title="Input peak (dBFS, pre-fader)">-∞</span>;
}

export function Meter({ id, height = 220, stereo = false, showGr = false }: { id: string; height?: number; stereo?: boolean; showGr?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const yellowDb = useConsole((s) => s.meterYellowDb ?? -10);
  useEffect(() => {
    const cv = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    cv.width = w * dpr;
    cv.height = height * dpr;
    const g = cv.getContext('2d')!;
    g.scale(dpr, dpr);
    const bars = stereo ? 2 : 1;
    const grW = showGr ? 4 : 0;
    const barW = (w - grW - (bars - 1) - (showGr ? 1 : 0)) / bars;
    // hard colour zones (like a console), so "just touching yellow" is easy to see when setting gain
    const pos = (db: number) => Math.max(0, Math.min(1, 1 - dbToY(db, height) / height));
    const grad = g.createLinearGradient(0, height, 0, 0);
    const y0 = pos(yellowDb), r0 = pos(METER_RED_DB);
    grad.addColorStop(0, '#2a8f50');
    grad.addColorStop(Math.max(0, y0 - 0.001), '#46c46f');
    grad.addColorStop(y0, '#f2cf3c');
    grad.addColorStop(Math.max(y0, r0 - 0.001), '#f2cf3c');
    grad.addColorStop(r0, '#e5484d');
    grad.addColorStop(1, '#e5484d');
    return registerMeter(id, (m) => {
      g.clearRect(0, 0, w, height);
      g.fillStyle = '#0c0e10';
      g.fillRect(0, 0, w, height);
      const levels = stereo ? [m?.db ?? -120, m?.dbR ?? -120] : [m?.db ?? -120];
      const holds = stereo ? [m?.hold ?? -120, m?.holdR ?? -120] : [m?.hold ?? -120];
      levels.forEach((db, i) => {
        const x = i * (barW + 1);
        const y = dbToY(db, height);
        g.fillStyle = grad;
        g.fillRect(x, y, barW, height - y);
        const hy = dbToY(holds[i], height);
        if (holds[i] > METER_MIN) {
          g.fillStyle = holds[i] > -3 ? '#e5484d' : '#d8d8d8';
          g.fillRect(x, hy, barW, 1.5);
        }
      });
      if (m?.clip) {
        g.fillStyle = '#e5484d';
        g.fillRect(0, 0, w - grW, 3);
      }
      if (showGr) {
        const x = w - grW;
        g.fillStyle = '#16191c';
        g.fillRect(x, 0, grW, height);
        const gr = Math.min(20, -(m?.gr ?? 0));
        if (gr > 0.2) {
          g.fillStyle = '#f0a020';
          g.fillRect(x, 0, grW, (gr / 20) * height * 0.5);
        }
      }
    });
  }, [id, height, stereo, showGr, yellowDb]);
  return <canvas ref={ref} className="meter" style={{ height, width: stereo ? 14 : showGr ? 12 : 8 }} />;
}

// ------------------------------------------------------------------ Knob
export function Knob({
  value,
  min,
  max,
  onChange,
  label,
  format,
  parse,
  log = false,
  size = 34,
  defaultValue,
  step,
  centre,
  color = 'var(--accent)',
  valueColor,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label?: string;
  format?: (v: number) => string;
  /** typed text → value (default: the first number in it, e.g. "+6 dB") */
  parse?: (text: string) => number | null;
  log?: boolean;
  size?: number;
  defaultValue?: number;
  step?: number;
  /** the value at 12 o'clock (e.g. 0 dB on a -24..+48 gain): each side of it gets half the travel */
  centre?: number;
  color?: string;
  valueColor?: string;
}) {
  const c0 = centre !== undefined && centre > min && centre < max && !log ? centre : undefined;
  const toT = (v: number) => {
    if (log) return Math.log(v / min) / Math.log(max / min);
    if (c0 !== undefined) return v <= c0 ? (0.5 * (v - min)) / (c0 - min) : 0.5 + (0.5 * (v - c0)) / (max - c0);
    return (v - min) / (max - min);
  };
  const fromT = (t: number) => {
    const c = Math.max(0, Math.min(1, t));
    let v = log ? min * Math.pow(max / min, c) : c0 !== undefined ? (c <= 0.5 ? min + (c / 0.5) * (c0 - min) : c0 + ((c - 0.5) / 0.5) * (max - c0)) : min + c * (max - min);
    if (step) v = Math.round(v / step) * step;
    return v;
  };
  const t = Math.max(0, Math.min(1, toT(value)));
  const drag = useRef<{ y: number; t: number; moved: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const a0 = -135, a1 = 135;
  const ang = a0 + t * (a1 - a0);
  const r = size / 2 - 3;
  const arc = (from: number, to: number) => {
    const p = (a: number) => [size / 2 + r * Math.sin((a * Math.PI) / 180), size / 2 - r * Math.cos((a * Math.PI) / 180)];
    const [x0, y0] = p(from);
    const [x1, y1] = p(to);
    return `M${x0},${y0} A${r},${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1},${y1}`;
  };
  // the arc grows from the centre value (0 dB / centre pan) when the range spans it
  const centreT = c0 !== undefined ? 0.5 : min < 0 && max > 0 && !log ? toT(0) : 0;
  const ca = a0 + centreT * (a1 - a0);
  const commit = (text: string) => {
    setEditing(false);
    const v = parse ? parse(text) : (() => { const m = /[-+]?\d*\.?\d+/.exec(text.replace(',', '.')); return m ? Number(m[0]) : null; })();
    if (v === null || !isFinite(v)) return;
    onChange(Math.max(min, Math.min(max, step ? Math.round(v / step) * step : v)));
  };
  return (
    <div className="knob" title={label} onClick={(e) => e.stopPropagation()}>
      <svg
        width={size}
        height={size}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, t, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          if (Math.abs(d.y - e.clientY) > 2) d.moved = true;
          if (!d.moved) return;
          const k = e.shiftKey ? 0.001 : 0.005;
          onChange(fromT(d.t + (d.y - e.clientY) * k));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          // a click (no drag) types a value; Option-click resets
          if (d && !d.moved) {
            if (e.altKey && defaultValue !== undefined) onChange(defaultValue);
            else setEditing(true);
          }
        }}
        onDoubleClick={() => {
          setEditing(false);
          if (defaultValue !== undefined) onChange(defaultValue);
        }}
      >
        <path d={arc(a0, a1)} style={{ stroke: 'var(--border-subtle)' }} strokeWidth={3} fill="none" />
        {Math.abs(ang - ca) > 0.5 && <path d={ang > ca ? arc(ca, ang) : arc(ang, ca)} stroke={color} strokeWidth={3} fill="none" />}
        <circle cx={size / 2} cy={size / 2} r={r - 4} style={{ fill: 'var(--surface-control)' }} />
        <line
          x1={size / 2}
          y1={size / 2}
          x2={size / 2 + (r - 5) * Math.sin((ang * Math.PI) / 180)}
          y2={size / 2 - (r - 5) * Math.cos((ang * Math.PI) / 180)}
          style={{ stroke: 'var(--text-primary)' }}
          strokeWidth={2}
          strokeLinecap="round"
        />
      </svg>
      {label && <div className="knob-label">{label}</div>}
      {editing ? (
        <input
          className="knob-edit"
          autoFocus
          defaultValue={format ? format(value) : value.toFixed(1)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit(e.currentTarget.value);
            if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={(e) => commit(e.currentTarget.value)}
          aria-label={label ?? 'Value'}
        />
      ) : (
        <div className="knob-value" style={valueColor ? { color: valueColor } : undefined} onClick={() => setEditing(true)}>
          {format ? format(value) : value.toFixed(1)}
        </div>
      )}
    </div>
  );
}

/** Pan text: "C", "L30", "R 20", "-30" (left) … → -1..1 */
export function parsePan(text: string): number | null {
  const t = text.trim().toUpperCase().replace(/^BAL\s*/, '');
  if (t === 'C' || t === '0') return 0;
  const m = /^([LR])?\s*([-+]?\d*\.?\d+)\s*([LR])?$/.exec(t);
  if (!m) return null;
  const side = m[1] ?? m[3];
  const n = Math.min(100, Math.abs(Number(m[2]))) / 100;
  return side === 'L' ? -n : side === 'R' ? n : Math.max(-1, Math.min(1, Number(m[2]) / 100));
}

export function Toggle({
  on,
  onClick,
  children,
  kind = 'default',
  title,
  small,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  kind?: 'default' | 'mute' | 'solo' | 'rec' | 'sel' | 'safe';
  title?: string;
  small?: boolean;
}) {
  return (
    <button className={`tgl tgl-${kind}${on ? ' on' : ''}${small ? ' small' : ''}`} onClick={onClick} title={title}>
      {children}
    </button>
  );
}

export const fmtHz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `${Math.round(v)}`);
export const fmtDb = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
export const fmtMs = (v: number) => (v >= 100 ? `${Math.round(v)}ms` : `${v.toFixed(1)}ms`);
