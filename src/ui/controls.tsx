import { useEffect, useRef } from 'react';
import { faderDbToPos, faderPosToDb, formatDb } from '../core/mix';
import { registerMeter } from './meterLoop';

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
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const rect = ref.current!.getBoundingClientRect();
    const capTop = rect.top + (1 - pos) * travel;
    const onCap = e.clientY >= capTop && e.clientY <= capTop + capHeight;
    if (!onCap) {
      // jump cap centre to click point
      const p = 1 - (e.clientY - rect.top - capHeight / 2) / travel;
      onChange(faderPosToDb(p));
      drag.current = { y: e.clientY, pos: Math.min(1, Math.max(0, p)) };
    } else {
      drag.current = { y: e.clientY, pos };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const fine = e.shiftKey ? 0.2 : 1;
    const p = drag.current.pos - ((e.clientY - drag.current.y) / travel) * fine;
    onChange(faderPosToDb(Math.min(1, Math.max(0, p))));
  };
  const end = () => (drag.current = null);
  const onWheel = (e: React.WheelEvent) => {
    const step = e.deltaY < 0 ? 0.5 : -0.5;
    const base = isFinite(db) ? db : -60;
    onChange(Math.min(10, base + step));
  };

  return (
    <div
      ref={ref}
      className="fader"
      style={{ height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onChange(0)}
      onWheel={onWheel}
      title={`${formatDb(db)} dB — double-click for 0 dB, shift-drag for fine`}
    >
      <div className="fader-slot" />
      {[10, 5, 0, -5, -10, -20, -30, -40, -60].map((m) => (
        <div key={m} className={'fader-tick' + (m === 0 ? ' zero' : '')} style={{ top: (1 - faderDbToPos(m)) * travel + capHeight / 2 }}>
          <span>{m > 0 ? `+${m}` : m}</span>
        </div>
      ))}
      <div className="fader-cap" style={{ top: (1 - pos) * travel, height: capHeight, borderTopColor: color }} />
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

export function Meter({ id, height = 220, stereo = false, showGr = false }: { id: string; height?: number; stereo?: boolean; showGr?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
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
    const grad = g.createLinearGradient(0, height, 0, 0);
    grad.addColorStop(0, '#2f9e5a');
    grad.addColorStop(dbToY(-18, height) > 0 ? 1 - dbToY(-18, height) / height : 0.7, '#3fbf6a');
    grad.addColorStop(1 - dbToY(-9, height) / height, '#e6c84a');
    grad.addColorStop(1 - dbToY(-3, height) / height, '#ef8a3a');
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
  }, [id, height, stereo, showGr]);
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
  log = false,
  size = 34,
  defaultValue,
  step,
  color = '#4aa3ff',
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label?: string;
  format?: (v: number) => string;
  log?: boolean;
  size?: number;
  defaultValue?: number;
  step?: number;
  color?: string;
}) {
  const toT = (v: number) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
  const fromT = (t: number) => {
    const c = Math.max(0, Math.min(1, t));
    let v = log ? min * Math.pow(max / min, c) : min + c * (max - min);
    if (step) v = Math.round(v / step) * step;
    return v;
  };
  const t = Math.max(0, Math.min(1, toT(value)));
  const drag = useRef<{ y: number; t: number } | null>(null);
  const a0 = -135, a1 = 135;
  const ang = a0 + t * (a1 - a0);
  const r = size / 2 - 3;
  const arc = (from: number, to: number) => {
    const p = (a: number) => [size / 2 + r * Math.sin((a * Math.PI) / 180), size / 2 - r * Math.cos((a * Math.PI) / 180)];
    const [x0, y0] = p(from);
    const [x1, y1] = p(to);
    return `M${x0},${y0} A${r},${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1},${y1}`;
  };
  const centreT = min < 0 && max > 0 && !log ? toT(0) : 0;
  const ca = a0 + centreT * (a1 - a0);
  return (
    <div className="knob" title={label}>
      <svg
        width={size}
        height={size}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, t };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const k = e.shiftKey ? 0.001 : 0.005;
          onChange(fromT(drag.current.t + (drag.current.y - e.clientY) * k));
        }}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
        onWheel={(e) => onChange(fromT(t + (e.deltaY < 0 ? 0.02 : -0.02)))}
      >
        <path d={arc(a0, a1)} stroke="#2a2f35" strokeWidth={3} fill="none" />
        {Math.abs(ang - ca) > 0.5 && <path d={ang > ca ? arc(ca, ang) : arc(ang, ca)} stroke={color} strokeWidth={3} fill="none" />}
        <circle cx={size / 2} cy={size / 2} r={r - 4} fill="#1d2126" />
        <line
          x1={size / 2}
          y1={size / 2}
          x2={size / 2 + (r - 5) * Math.sin((ang * Math.PI) / 180)}
          y2={size / 2 - (r - 5) * Math.cos((ang * Math.PI) / 180)}
          stroke="#e8e8e8"
          strokeWidth={2}
          strokeLinecap="round"
        />
      </svg>
      {label && <div className="knob-label">{label}</div>}
      <div className="knob-value">{format ? format(value) : value.toFixed(1)}</div>
    </div>
  );
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
