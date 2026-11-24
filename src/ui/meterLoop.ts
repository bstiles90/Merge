// One requestAnimationFrame loop reads all engine meters and redraws registered
// canvases directly – no React renders at 60 fps.

import { getEngine, type LoudnessReading, type MeterReading } from '../audio/engine';
import { isNativeConnected, readNativeLoudness, readNativeMeters } from '../native/bridge';

type Draw = (m: SmoothedMeter | undefined) => void;
export interface SmoothedMeter {
  db: number;
  dbR?: number;
  hold: number;
  holdR?: number;
  gr: number;
  clip: boolean;
}

const draws = new Map<string, Set<Draw>>();
const smoothed = new Map<string, SmoothedMeter & { holdT: number; holdTR: number; clipT: number }>();
const loudnessDraws = new Set<(l: LoudnessReading) => void>();
let running = false;

const toDb = (g: number) => (g > 0 ? 20 * Math.log10(g) : -120);

export function registerMeter(id: string, draw: Draw) {
  let set = draws.get(id);
  if (!set) draws.set(id, (set = new Set()));
  set.add(draw);
  ensure();
  return () => {
    set!.delete(draw);
  };
}

export function registerLoudness(fn: (l: LoudnessReading) => void) {
  loudnessDraws.add(fn);
  ensure();
  return () => {
    loudnessDraws.delete(fn);
  };
}

function ballistics(id: string, r: MeterReading, now: number) {
  let s = smoothed.get(id);
  if (!s) {
    s = { db: -120, hold: -120, gr: 0, clip: false, holdT: 0, holdTR: 0, clipT: 0 };
    smoothed.set(id, s);
  }
  const fall = 0.6; // dB per frame (~36 dB/s)
  const d = toDb(r.peak);
  s.db = d > s.db ? d : Math.max(d, s.db - fall);
  if (d >= s.hold || now - s.holdT > 1500) {
    s.hold = d;
    s.holdT = now;
  }
  if (r.peakR !== undefined) {
    const dr = toDb(r.peakR);
    s.dbR = s.dbR === undefined || dr > s.dbR ? dr : Math.max(dr, s.dbR - fall);
    if (s.holdR === undefined || dr >= s.holdR || now - s.holdTR > 1500) {
      s.holdR = dr;
      s.holdTR = now;
    }
  }
  if (Math.max(r.peak, r.peakR ?? 0) >= 0.999) s.clipT = now;
  s.clip = now - s.clipT < 2000;
  s.gr = r.gr ?? 0;
  return s;
}

function ensure() {
  if (running) return;
  running = true;
  const tick = (now: number) => {
    const native = isNativeConnected();
    const eng = native ? null : getEngine();
    const readings = native ? readNativeMeters() : eng?.readMeters();
    for (const [id, set] of draws) {
      if (!set.size) continue;
      const r = readings?.get(id);
      const m = r ? ballistics(id, r, now) : undefined;
      set.forEach((fn) => fn(m));
    }
    if (native) loudnessDraws.forEach((fn) => fn(readNativeLoudness()));
    else if (eng) loudnessDraws.forEach((fn) => fn(eng.loudness));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
