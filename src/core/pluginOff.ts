// Turning a plugin slot off: it stays in the show (with its settings) but isn't loaded at all.
// Used when a plugin crashed Merge: the next launch switches that one off instead of crashing again.

import type { ConsoleState, InsertSlot } from './types';

type Strips = Pick<ConsoleState, 'channels' | 'buses' | 'main'>;

/** The strips with slot `slotId` turned off (or on), and the name of the strip it's on (null = not found). */
export function setSlotOffline<S extends Strips>(s: S, slotId: string, offline: boolean): { state: S; strip: string | null } {
  let strip: string | null = null;
  const fix = (list: InsertSlot[], name: string) => {
    if (!list.some((i) => i.id === slotId)) return list;
    strip = name;
    return list.map((i) => (i.id !== slotId ? i : offline ? { ...i, offline: true } : (({ offline: _o, ...rest }) => rest)(i)));
  };
  const state = {
    ...s,
    channels: s.channels.map((c) => ({ ...c, inserts: fix(c.inserts, c.name) })),
    buses: s.buses.map((b) => ({ ...b, inserts: fix(b.inserts, b.name) })),
    main: { ...s.main, inserts: fix(s.main.inserts, 'Main LR') },
  };
  return { state, strip };
}

export interface CrashedPlugin {
  kind: string; // "render" | "load"
  slotId: string;
  name: string;
}

export function crashNotice(p: CrashedPlugin, strip: string) {
  const when = p.kind === 'load' ? 'while it was loading' : 'while it was processing audio';
  return `${p.name} on ${strip} crashed Merge ${when}, so it's switched off (its settings are kept). Turn it back on from its rack menu when you want to try it again.`;
}
