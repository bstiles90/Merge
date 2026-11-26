// Compiles console state into the native engine's "mix plan": all console logic
// (mute groups, DCAs, solo/cue, mix-minus, talkback dim) is resolved here, once,
// in TypeScript. The engine only renders gains and DSP parameters. Mirrors
// engine/src/Plan.cpp.

import { anySolo, busMuteReason, computeBusGain, computeChannelGains, computeMainGain, computeMonitorGain, dbToGain } from './mix';
import { isPreFader, sendTap } from './sends';
import { playbackClips } from './multitrack';
import type { Bus, ConsoleState, InsertSlot } from './types';

export interface PlanInsert {
  id: string;
  pluginId: string;
  bypass: boolean;
}

const inserts = (list: InsertSlot[]): PlanInsert[] => list.filter((i) => !i.offline).map((i) => ({ id: i.id, pluginId: i.pluginId, bypass: i.bypass }));
const r = (x: number) => Math.round(x * 1e6) / 1e6; // keep the JSON small and stable

/** Where a bus goes: 'main', another bus id, or '' (outputs only). Loops are cut. */
export function busTarget(s: Pick<ConsoleState, 'buses'>, id: string): string {
  const b = s.buses.find((x) => x.id === id);
  const out = b?.output ?? 'none';
  if (out === 'main') return 'main';
  if (out === 'none' || out === id || !s.buses.some((x) => x.id === out)) return '';
  return createsLoop(s, id, out) ? '' : out;
}

/** Buses a bus feeds: its output and the buses it sends to. */
function feeds(s: Pick<ConsoleState, 'buses'>, id: string): string[] {
  const b = s.buses.find((x) => x.id === id);
  if (!b) return [];
  const out = b.output && b.output !== 'main' && b.output !== 'none' ? [b.output] : [];
  for (const [t, snd] of Object.entries(b.sends ?? {})) if (snd.on && t !== id && !out.includes(t)) out.push(t);
  return out;
}

/** Would feeding bus `from` into bus `to` (output or send) make a loop (to → … → from)? */
export function createsLoop(s: Pick<ConsoleState, 'buses'>, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...feeds(s, cur));
  }
  return false;
}

/** Buses ordered so each comes before every bus it feeds (the engine processes them in this order). */
export function busOrder(s: Pick<ConsoleState, 'buses'>): string[] {
  const memo = new Map<string, number>();
  const depth = (id: string, path: Set<string>): number => {
    const m = memo.get(id);
    if (m !== undefined) return m;
    if (path.has(id)) return 0; // a loop: cut here (the engine drops the link)
    path.add(id);
    let d = 0;
    for (const t of feeds(s, id)) if (s.buses.some((x) => x.id === t)) d = Math.max(d, 1 + depth(t, path));
    path.delete(id);
    memo.set(id, d);
    return d; // longest chain of buses downstream: further from Main LR = earlier
  };
  return s.buses.map((b, i) => ({ id: b.id, d: depth(b.id, new Set()), i })).sort((a, b) => b.d - a.d || a.i - b.i).map((x) => x.id);
}

/** A bus's sends for the engine: post sends follow the bus fader (and mute) there; pre sends
 *  are cut here when the bus is muted. Sends that would loop are left out. */
function busSends(s: ConsoleState, b: Bus, muted: boolean) {
  const out: { bus: string; gain: number; pre: boolean }[] = [];
  for (const [t, snd] of Object.entries(b.sends ?? {})) {
    const target = s.buses.find((x) => x.id === t);
    if (!snd.on || t === b.id || !target || target.created === false || !isFinite(snd.levelDb)) continue;
    const pre = isPreFader(sendTap(snd));
    out.push({ bus: t, gain: r(pre && muted ? 0 : dbToGain(snd.levelDb)), pre });
  }
  return out;
}

export function buildMixPlan(s: ConsoleState) {
  const solo = anySolo(s);
  const pfl = s.monitor.soloMode === 'pfl';
  return {
    channels: s.channels.map((ch) => {
      const g = computeChannelGains(s, ch);
      return {
        id: ch.id,
        src: {
          kind: ch.source.kind,
          freq: ch.source.freq,
          input: ch.source.kind === 'input' ? ch.source.deviceChannel ?? 0 : -1,
          ...(ch.stereo && ch.source.kind === 'input' ? { inputR: ch.source.deviceChannelR ?? (ch.source.deviceChannel ?? 0) + 1 } : {}),
        },
        ...(ch.stereo ? { stereo: true } : {}),
        playback: ch.inputMode === 'playback',
        ...(ch.inputMode === 'playback' ? { clips: playbackClips(s, ch.id) } : {}),
        gain: r(dbToGain(ch.gainDb) * (ch.phaseInvert ? -1 : 1)),
        delayMs: ch.delayMs,
        inserts: inserts(ch.inserts),
        pan: ch.pan,
        post: r(g.post),
        main: ch.mainAssign ? 1 : 0,
        sends: [
          ...Object.entries(g.routes).filter(([, v]) => v > 0).map(([bus, v]) => ({ bus, gain: r(v), pre: false, route: true })),
          // a bus the channel is assigned to takes the assignment, not a send as well
          ...Object.entries(g.sends)
            .filter(([bus, v]) => v.gain > 0 && !(bus in g.routes))
            .map(([bus, v]) => ({ bus, gain: r(v.gain), pre: v.pre, tap: v.tap, ...(v.after ? { after: v.after } : {}) })),
        ],
        cue: r(g.cue),
        cuePre: g.cuePre,
      };
    }),
    buses: s.buses.map((b) => {
      const g = computeBusGain(s, b);
      return {
        id: b.id,
        out: r(g.out),
        cuePre: b.solo && pfl ? 1 : 0,
        cuePost: b.solo && !pfl ? 1 : 0,
        delayMs: b.delayMs,
        inserts: inserts(b.inserts),
        to: busTarget(s, b.id),
        ...(b.sends && Object.keys(b.sends).length ? { sends: busSends(s, b, busMuteReason(s, b).muted) } : {}),
      };
    }),
    busOrder: busOrder(s),
    main: { out: r(computeMainGain(s)), delayMs: s.main.delayMs, inserts: inserts(s.main.inserts) },
    monitor: {
      source: solo ? 'cue' : s.monitor.source,
      gain: r(computeMonitorGain(s) * (s.talkback.active ? dbToGain(-20) : 1)),
    },
    outputs: s.io.outputPatch,
    talkback: {
      gain: s.talkback.active ? r(dbToGain(s.talkback.levelDb)) : 0,
      input: s.talkback.deviceId ? s.talkback.deviceChannel : -1,
      dest: s.talkback.destinations,
    },
  };
}

export type MixPlan = ReturnType<typeof buildMixPlan>;
