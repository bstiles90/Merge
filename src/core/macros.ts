// User macros: a named sequence of steps run from one button, like a ProPresenter macro.
//   action : any user-key action (mute groups, scenes, pages, mutes, plugin bypass...)
//   fade   : move a fader to a level over a time (runs alongside the next steps, or waits)
//   wait   : pause before the next step
// Running a macro again restarts it. A fader moved by hand during a macro fade is left alone.

import { runActions } from './actions';
import type { ConsoleState, Macro, MacroStep, StripRef } from './types';

const FLOOR = -90;
const ease = (t: number) => t * t * (3 - 2 * t);

function getFader(s: ConsoleState, r: StripRef): number | undefined {
  if (r.kind === 'channel') return s.channels.find((c) => c.id === r.id)?.faderDb;
  if (r.kind === 'bus') return s.buses.find((b) => b.id === r.id)?.faderDb;
  if (r.kind === 'dca') return s.dcas.find((d) => d.id === r.id)?.faderDb;
  return s.main.faderDb;
}
function setFader(s: ConsoleState, r: StripRef, db: number): Partial<ConsoleState> {
  if (r.kind === 'channel') return { channels: s.channels.map((c) => (c.id === r.id ? { ...c, faderDb: db } : c)) };
  if (r.kind === 'bus') return { buses: s.buses.map((b) => (b.id === r.id ? { ...b, faderDb: db } : b)) };
  if (r.kind === 'dca') return { dcas: s.dcas.map((d) => (d.id === r.id ? { ...d, faderDb: db } : d)) };
  return { main: { ...s.main, faderDb: db } };
}

export interface MacroHost {
  get: () => ConsoleState;
  set: (p: Partial<ConsoleState>) => void;
}

const sleep = (ms: number, alive: () => boolean) =>
  new Promise<void>((res) => {
    const t0 = Date.now();
    const poll = () => (!alive() || Date.now() - t0 >= ms ? res() : setTimeout(poll, Math.min(30, ms)));
    setTimeout(poll, Math.min(30, ms));
  });

/** Move one fader to `db` over `ms` (S-curve). Resolves when done, stopped, or grabbed by hand. */
function glide(host: MacroHost, target: StripRef, db: number, ms: number, alive: () => boolean): Promise<void> {
  const from = getFader(host.get(), target);
  if (from === undefined) return Promise.resolve();
  const a = isFinite(from) ? from : FLOOR;
  const b = isFinite(db) ? db : FLOOR;
  if (ms <= 0) {
    host.set(setFader(host.get(), target, db));
    return Promise.resolve();
  }
  return new Promise((res) => {
    const t0 = Date.now();
    let last = from;
    const tick = () => {
      if (!alive()) return res();
      const s = host.get();
      if (getFader(s, target) !== last) return res(); // moved by hand: let go
      const t = Math.min(1, (Date.now() - t0) / ms);
      const v = t >= 1 ? db : a + (b - a) * ease(t);
      const out = t >= 1 ? db : !isFinite(db) && v <= FLOOR + 0.01 ? -Infinity : v;
      host.set(setFader(s, target, out));
      last = out;
      if (t >= 1) res();
      else setTimeout(tick, 33);
    };
    setTimeout(tick, 33);
  });
}

const runs = new Map<string, { alive: boolean }>();

function markRunning(host: MacroHost, id: string, on: boolean) {
  const cur = host.get().macrosRunning ?? [];
  const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
  host.set({ macrosRunning: next });
}

export async function runMacro(host: MacroHost, macro: Macro) {
  stopMacro(host, macro.id);
  const token = { alive: true };
  runs.set(macro.id, token);
  const alive = () => token.alive;
  markRunning(host, macro.id, true);
  const pending: Promise<void>[] = [];
  try {
    for (const step of macro.steps as MacroStep[]) {
      if (!alive()) break;
      if (step.kind === 'action') host.set(runActions(host.get(), [step.call]));
      else if (step.kind === 'wait') await sleep(Math.max(0, step.sec) * 1000, alive);
      else if (step.kind === 'fade') {
        const p = glide(host, step.target, step.db <= -90 ? -Infinity : step.db, Math.max(0, step.sec) * 1000, alive);
        if (step.wait) await p;
        else pending.push(p);
      }
    }
    await Promise.all(pending); // the key stays lit until every fader move has finished
  } finally {
    if (runs.get(macro.id) === token) {
      runs.delete(macro.id);
      markRunning(host, macro.id, false);
    }
  }
}

export function stopMacro(host: MacroHost, id: string) {
  const r = runs.get(id);
  if (r) {
    r.alive = false;
    runs.delete(id);
    markRunning(host, id, false);
  }
}

/** Plain-English summary of a step (for lists). */
export function describeStep(s: ConsoleState, step: MacroStep, describeAction: (s: ConsoleState, c: MacroStep & { kind: 'action' }) => string): string {
  if (step.kind === 'wait') return `Wait ${step.sec} s`;
  if (step.kind === 'action') return describeAction(s, step);
  const t = step.target;
  const name = t.kind === 'main' ? 'Main LR' : t.kind === 'channel' ? s.channels.find((c) => c.id === t.id)?.name : t.kind === 'bus' ? s.buses.find((b) => b.id === t.id)?.name : s.dcas.find((d) => d.id === t.id)?.name;
  return `Fade ${name ?? '?'} to ${step.db <= -90 ? '-∞' : `${step.db} dB`} over ${step.sec} s${step.wait ? ' (then continue)' : ''}`;
}
