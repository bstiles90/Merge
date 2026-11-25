// Pure mix maths: how faders, DCAs, mute groups, solos and mix-minus combine into
// the actual gains the engine applies. Kept free of Web Audio so it is unit tested
// and portable to a native engine.

import type { Bus, Channel, ConsoleState, SendTap } from './types';
import { isPreFader, sendTap, tapAfterCount } from './sends';

export const NEG_INF = -Infinity;
export const MIN_DB = -90;

export function dbToGain(db: number): number {
  if (!isFinite(db) || db <= MIN_DB) return 0;
  return Math.pow(10, db / 20);
}

export function gainToDb(g: number): number {
  if (g <= 0) return NEG_INF;
  return 20 * Math.log10(g);
}

// Console-style fader taper. Position 0..1 -> dB.
const TAPER: [number, number][] = [
  [0, MIN_DB],
  [0.04, -60],
  [0.15, -40],
  [0.3, -25],
  [0.45, -15],
  [0.6, -7.5],
  [0.75, 0],
  [0.875, 5],
  [1, 10],
];

export function faderPosToDb(pos: number): number {
  const p = Math.min(1, Math.max(0, pos));
  if (p <= 0) return NEG_INF;
  for (let i = 1; i < TAPER.length; i++) {
    const [p1, d1] = TAPER[i];
    const [p0, d0] = TAPER[i - 1];
    if (p <= p1) return d0 + ((p - p0) / (p1 - p0)) * (d1 - d0);
  }
  return 10;
}

export function faderDbToPos(db: number): number {
  if (!isFinite(db) || db <= MIN_DB) return 0;
  if (db >= 10) return 1;
  for (let i = 1; i < TAPER.length; i++) {
    const [p1, d1] = TAPER[i];
    const [p0, d0] = TAPER[i - 1];
    if (db <= d1) return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
  }
  return 1;
}

export function formatDb(db: number, digits = 1): string {
  if (!isFinite(db) || db <= MIN_DB) return '-∞';
  return (db > 0 ? '+' : '') + db.toFixed(digits);
}

/** Why a strip is muted – useful for UI (e.g. show a mute-group mute differently). */
export interface MuteReason {
  muted: boolean;
  self: boolean;
  groups: string[];
  dcas: string[];
}

export function channelMuteReason(s: Pick<ConsoleState, 'muteGroups' | 'dcas'>, ch: Channel): MuteReason {
  const groups = ch.muteGroups.filter((g) => s.muteGroups.find((m) => m.id === g)?.active);
  const dcas = ch.dcas.filter((d) => s.dcas.find((x) => x.id === d)?.mute);
  return { muted: ch.mute || groups.length > 0 || dcas.length > 0, self: ch.mute, groups, dcas };
}

export function busMuteReason(s: Pick<ConsoleState, 'muteGroups'>, bus: Bus): MuteReason {
  const groups = bus.muteGroups.filter((g) => s.muteGroups.find((m) => m.id === g)?.active);
  return { muted: bus.mute || groups.length > 0, self: bus.mute, groups, dcas: [] };
}

/** Channel fader level after DCA offsets are applied (dB). */
export function channelEffectiveFaderDb(s: Pick<ConsoleState, 'dcas'>, ch: Channel): number {
  if (!isFinite(ch.faderDb)) return NEG_INF;
  let db = ch.faderDb;
  for (const id of ch.dcas) {
    const d = s.dcas.find((x) => x.id === id);
    if (!d) continue;
    if (!isFinite(d.faderDb)) return NEG_INF;
    db += d.faderDb;
  }
  return Math.min(db, 10 + 10 * Math.max(1, ch.dcas.length));
}

export interface ChannelGains {
  /** post-fader gain into the main bus (0 if muted or unassigned) */
  main: number;
  /** post-fader gain (fader + DCA + mute), before main assign */
  post: number;
  /** output assignment gains to buses (groups), panned like Main LR */
  routes: Record<string, number>;
  sends: Record<string, { gain: number; pre: boolean; tap: SendTap; after?: number }>;
  /** gain into the cue (solo) bus */
  cue: number;
  cuePre: boolean;
}

export function anySolo(s: Pick<ConsoleState, 'channels' | 'buses'>): boolean {
  return s.channels.some((c) => c.solo) || s.buses.some((b) => b.solo);
}

export function computeChannelGains(s: ConsoleState, ch: Channel): ChannelGains {
  const mute = channelMuteReason(s, ch).muted;
  const post = mute ? 0 : dbToGain(channelEffectiveFaderDb(s, ch));
  const sends: ChannelGains['sends'] = {};
  for (const bus of s.buses) {
    if (bus.type === 'mixminus') {
      // Mix-minus: everything going to the main mix, minus the excluded source,
      // at the channel's post-fader level.
      const on = ch.mainAssign && bus.mixMinusExclude !== ch.id;
      sends[bus.id] = { gain: on ? post : 0, pre: false, tap: 'psp' };
      continue;
    }
    const send = ch.sends[bus.id];
    if (!send || !send.on || mute) {
      sends[bus.id] = { gain: 0, pre: send?.pre ?? false, tap: send ? sendTap(send) : 'post' };
      continue;
    }
    const sendGain = dbToGain(send.levelDb);
    const tap = sendTap(send);
    const pre = isPreFader(tap);
    sends[bus.id] = { gain: pre ? sendGain : sendGain * post, pre, tap, after: tapAfterCount(ch, send) };
  }
  // output assignments to buses (groups): at the channel's post-fader level, panned like Main LR
  const routes: Record<string, number> = {};
  for (const id of ch.routes ?? []) if (s.buses.some((b) => b.id === id && b.type !== 'mixminus')) routes[id] = post;
  const pfl = s.monitor.soloMode === 'pfl';
  return {
    main: ch.mainAssign ? post : 0,
    post,
    routes,
    sends,
    cue: ch.solo ? (pfl ? 1 : post) : 0,
    cuePre: pfl,
  };
}

export function computeBusGain(s: ConsoleState, bus: Bus): { out: number; cue: number } {
  const mute = busMuteReason(s, bus).muted;
  const out = mute ? 0 : dbToGain(bus.faderDb);
  return { out, cue: bus.solo ? (s.monitor.soloMode === 'pfl' ? 1 : out) : 0 };
}

export function computeMainGain(s: ConsoleState): number {
  return s.main.mute ? 0 : dbToGain(s.main.faderDb);
}

/** Monitor output gain, with dim applied. */
export function computeMonitorGain(s: ConsoleState): number {
  return dbToGain(s.monitor.levelDb + (s.monitor.dim ? s.monitor.dimDb : 0));
}
