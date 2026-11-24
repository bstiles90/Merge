// Stereo links: two mono channels that move together (like a console's stereo link),
// while keeping their own pan and plugins (so each side can be processed separately in its rack).

import type { Channel, ChannelId, ConsoleState, StereoLink } from './types';

export type LinkOption = keyof StereoLink['options'];

/** Which channel fields each link option keeps in sync. Pan and inserts are never linked. */
const LINKED_FIELDS: Record<LinkOption, (keyof Channel)[]> = {
  fader: ['faderDb'],
  mute: ['mute'],
  solo: ['solo'],
  sends: ['sends'],
  groups: ['dcas', 'muteGroups', 'mainAssign'],
  input: ['gainDb', 'delayMs'],
};

export const DEFAULT_LINK_OPTIONS: StereoLink['options'] = {
  fader: true,
  mute: true,
  solo: true,
  sends: true,
  groups: true,
  input: true,
};

export function findLink(s: Pick<ConsoleState, 'stereoLinks'>, id: ChannelId): StereoLink | undefined {
  return s.stereoLinks.find((l) => l.left === id || l.right === id);
}

/** Partner channel for a linked channel, and which side this one is. */
export function linkInfo(s: Pick<ConsoleState, 'stereoLinks'>, id: ChannelId): { partner: ChannelId; side: 'L' | 'R'; link: StereoLink } | null {
  const l = findLink(s, id);
  if (!l) return null;
  return l.left === id ? { partner: l.right, side: 'L', link: l } : { partner: l.left, side: 'R', link: l };
}

/** The natural partner for linking: odd channels pair with the next one (1+2, 3+4, …). */
export function naturalPartner(id: ChannelId): ChannelId {
  const n = Number(id.replace('ch', ''));
  return `ch${n % 2 === 1 ? n + 1 : n - 1}`;
}

function copyLinked(from: Channel, to: Channel, options: StereoLink['options']): Channel {
  // a stereo pair is one source: it always has one role, so show moments move both sides together
  let out = from.role !== to.role ? { ...to, role: from.role } : to;
  for (const opt of Object.keys(LINKED_FIELDS) as LinkOption[]) {
    if (!options[opt]) continue;
    for (const f of LINKED_FIELDS[opt]) {
      if (out[f] !== from[f]) out = { ...out, [f]: structuredClone(from[f]) };
    }
  }
  return out;
}

/**
 * After a state change, mirror linked fields from whichever side of each link changed onto the
 * other side. Returns the same array if nothing needed syncing.
 */
export function syncLinks(prev: Pick<ConsoleState, 'channels'>, next: Pick<ConsoleState, 'channels' | 'stereoLinks'>): Channel[] {
  if (!next.stereoLinks.length || prev.channels === next.channels) return next.channels;
  let channels = next.channels;
  for (const link of next.stereoLinks) {
    const ia = channels.findIndex((c) => c.id === link.left);
    const ib = channels.findIndex((c) => c.id === link.right);
    if (ia < 0 || ib < 0) continue;
    const a = channels[ia], b = channels[ib];
    const pa = prev.channels.find((c) => c.id === link.left);
    const pb = prev.channels.find((c) => c.id === link.right);
    const aChanged = a !== pa;
    const bChanged = b !== pb;
    if (!aChanged && !bChanged) continue;
    // if both changed in one step (e.g. a scene recall), the left side wins
    const [src, dstIdx, dst] = aChanged ? [a, ib, b] : [b, ia, a];
    const synced = copyLinked(src, dst, link.options);
    if (synced !== dst) {
      if (channels === next.channels) channels = channels.slice();
      channels[dstIdx] = synced;
    }
  }
  return channels;
}

/** Create a link between `left` and `right`: pans go hard L/R and linked settings follow the left side. */
export function createLink(s: ConsoleState, left: ChannelId, right: ChannelId): Partial<ConsoleState> {
  const without = s.stereoLinks.filter((l) => ![l.left, l.right].some((id) => id === left || id === right));
  const link: StereoLink = { left, right, options: { ...DEFAULT_LINK_OPTIONS } };
  const a = s.channels.find((c) => c.id === left);
  const channels = s.channels.map((c) => {
    if (c.id === left) return { ...c, pan: -1 };
    if (c.id === right && a) return { ...copyLinked(a, c, link.options), pan: 1 };
    return c;
  });
  return { stereoLinks: [...without, link], channels };
}

export function removeLink(s: ConsoleState, id: ChannelId): Partial<ConsoleState> {
  return { stereoLinks: s.stereoLinks.filter((l) => l.left !== id && l.right !== id) };
}

export function setLinkOption(s: ConsoleState, id: ChannelId, opt: LinkOption, on: boolean): Partial<ConsoleState> {
  const stereoLinks = s.stereoLinks.map((l) => (l.left === id || l.right === id ? { ...l, options: { ...l.options, [opt]: on } } : l));
  const link = stereoLinks.find((l) => l.left === id || l.right === id);
  if (!on || !link) return { stereoLinks };
  // turning an option on: bring the right side in line with the left
  const a = s.channels.find((c) => c.id === link.left)!;
  return { stereoLinks, channels: s.channels.map((c) => (c.id === link.right ? copyLinked(a, c, link.options) : c)) };
}
