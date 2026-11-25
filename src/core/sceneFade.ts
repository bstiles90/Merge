// Timed scene recalls: faders, send levels, pan and gain glide from where they are to the
// scene's values over the scene's fade time (S-curve). Everything else (mutes, routing,
// plugins, names) switches at the start, as on LV1. If you move something by hand during a
// fade, that one control stops following the fade.

import type { ConsoleState } from './types';

const FLOOR = -90; // -inf fades from / to here
const toNum = (db: number) => (isFinite(db) ? db : FLOOR);
const fromNum = (db: number, target: number) => (!isFinite(target) && db <= FLOOR + 0.01 ? -Infinity : db);
const ease = (t: number) => t * t * (3 - 2 * t);

type Path = { get: (s: ConsoleState) => number; set: (s: ConsoleState, v: number) => ConsoleState };

/** Every continuous value that differs between `from` and `to`. */
function fadePaths(from: ConsoleState, to: ConsoleState): { path: Path; a: number; b: number; raw: number }[] {
  const out: { path: Path; a: number; b: number; raw: number }[] = [];
  const add = (path: Path, dbLike: boolean) => {
    const a0 = path.get(from), b0 = path.get(to);
    if (a0 === b0) return;
    out.push({ path, a: dbLike ? toNum(a0) : a0, b: dbLike ? toNum(b0) : b0, raw: b0 });
  };
  to.channels.forEach((c, i) => {
    const ch = (f: (x: ConsoleState['channels'][number]) => number, k: 'faderDb' | 'pan' | 'gainDb'): Path => ({
      get: (s) => f(s.channels[i]),
      set: (s, v) => ({ ...s, channels: s.channels.map((x, j) => (j === i ? { ...x, [k]: v } : x)) }),
    });
    add(ch((x) => x.faderDb, 'faderDb'), true);
    add(ch((x) => x.pan, 'pan'), false);
    add(ch((x) => x.gainDb, 'gainDb'), false);
    for (const bus of Object.keys(c.sends)) {
      const prev = from.channels[i].sends[bus];
      if (!prev || !c.sends[bus]) continue;
      add({
        get: (s) => s.channels[i].sends[bus]?.levelDb ?? -Infinity,
        set: (s, v) => ({ ...s, channels: s.channels.map((x, j) => (j === i && x.sends[bus] ? { ...x, sends: { ...x.sends, [bus]: { ...x.sends[bus], levelDb: v } } } : x)) }),
      }, true);
    }
  });
  to.buses.forEach((_, i) =>
    add({ get: (s) => s.buses[i].faderDb, set: (s, v) => ({ ...s, buses: s.buses.map((x, j) => (j === i ? { ...x, faderDb: v } : x)) }) }, true),
  );
  to.dcas.forEach((_, i) =>
    add({ get: (s) => s.dcas[i].faderDb, set: (s, v) => ({ ...s, dcas: s.dcas.map((x, j) => (j === i ? { ...x, faderDb: v } : x)) }) }, true),
  );
  add({ get: (s) => s.main.faderDb, set: (s, v) => ({ ...s, main: { ...s.main, faderDb: v } }) }, true);
  return out;
}

let running: { stop: () => void } | null = null;

/** Start a fade: `set` writes state, `get` reads the current state. */
export function startSceneFade(from: ConsoleState, to: ConsoleState, ms: number, get: () => ConsoleState, set: (s: Partial<ConsoleState>) => void) {
  running?.stop();
  const paths = fadePaths(from, to);
  // start: everything from the scene except the gliding values, which start where they were
  let start = to;
  for (const p of paths) start = p.path.set(start, fromNum(p.a, p.raw));
  set(start);
  if (!paths.length) return;
  const last = new Map(paths.map((p) => [p, p.path.get(start)]));
  const t0 = performance.now();
  let alive = true;
  const tick = () => {
    if (!alive) return;
    const t = Math.min(1, (performance.now() - t0) / ms);
    let s = get();
    let changed = false;
    for (const p of paths) {
      if (!last.has(p)) continue;
      if (p.path.get(s) !== last.get(p)) { last.delete(p); continue; } // moved by hand: let go
      const v = t >= 1 ? p.raw : fromNum(p.a + (p.b - p.a) * ease(t), p.raw);
      s = p.path.set(s, v);
      last.set(p, v);
      changed = true;
    }
    if (changed) set({ channels: s.channels, buses: s.buses, dcas: s.dcas, main: s.main });
    if (t < 1 && last.size) setTimeout(tick, 33);
    else running = null;
  };
  running = { stop: () => (alive = false) };
  setTimeout(tick, 33);
}

export const stopSceneFade = () => running?.stop();
