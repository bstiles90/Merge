// Compiles console state into the native engine's "mix plan": all console logic
// (mute groups, DCAs, solo/cue, mix-minus, talkback dim) is resolved here, once,
// in TypeScript. The engine only renders gains and DSP parameters. Mirrors
// engine/src/Plan.cpp.

import { anySolo, computeBusGain, computeChannelGains, computeMainGain, computeMonitorGain, dbToGain } from './mix';
import type { ConsoleState, InsertSlot } from './types';

export interface PlanInsert {
  id: string;
  pluginId: string;
  bypass: boolean;
}

const inserts = (list: InsertSlot[]): PlanInsert[] => list.map((i) => ({ id: i.id, pluginId: i.pluginId, bypass: i.bypass }));
const r = (x: number) => Math.round(x * 1e6) / 1e6; // keep the JSON small and stable

/** How long after a moment its fade is still sent with the plan (the engine starts it once). */
const FADE_WINDOW_MS = 3000;

export function buildMixPlan(s: ConsoleState, now = Date.now()) {
  const solo = anySolo(s);
  const f = s.automation?.fade;
  const fade = f && now - f.at < f.ms + FADE_WINDOW_MS ? f : null;
  const pfl = s.monitor.soloMode === 'pfl';
  return {
    channels: s.channels.map((ch) => {
      const g = computeChannelGains(s, ch);
      return {
        id: ch.id,
        src: { kind: ch.source.kind, freq: ch.source.freq, input: ch.source.kind === 'input' ? ch.source.deviceChannel ?? 0 : -1 },
        playback: ch.inputMode === 'playback',
        gain: r(dbToGain(ch.gainDb) * (ch.phaseInvert ? -1 : 1)),
        delayMs: ch.delayMs,
        inserts: inserts(ch.inserts),
        pan: ch.pan,
        post: r(g.post),
        main: ch.mainAssign ? 1 : 0,
        sends: Object.entries(g.sends)
          .filter(([, v]) => v.gain > 0)
          .map(([bus, v]) => ({ bus, gain: r(v.gain), pre: v.pre })),
        cue: r(g.cue),
        cuePre: g.cuePre,
        ...(fade && fade.channels.includes(ch.id) ? { fadeId: fade.id, fadeMs: fade.ms } : {}),
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
      };
    }),
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
