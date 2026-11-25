// Buses: 64 slots, but only the ones you create show up in routing, sends and outputs.
import { LAYER_SLOTS } from './defaults';
import type { Bus, BusRole, ConsoleState } from './types';

export const BUS_ROLES: { id: BusRole; label: string; short: string; about: string }[] = [
  { id: 'group', label: 'Group', short: 'GRP', about: 'Channels assigned to it (e.g. Drums, Vocals); goes to Main LR' },
  { id: 'aux', label: 'Aux / IEM', short: 'AUX', about: 'A separate mix from sends (in-ears, stage, stream feed); goes to outputs' },
  { id: 'fx', label: 'FX return', short: 'FX', about: 'Reverb / delay on its rack, fed by sends; goes to Main LR' },
  { id: 'matrix', label: 'Matrix / feed', short: 'MTX', about: 'A feed made from other buses; goes to outputs' },
];
export const roleOf = (b: Bus) => BUS_ROLES.find((r) => r.id === b.role);

const DEFAULT_NAME = /^(Bus|Aux) \d+$/;

/** Is this bus used anywhere (named, routed, sent to, patched, fed)? Used to upgrade older shows. */
export function busInUse(s: Pick<ConsoleState, 'channels' | 'buses' | 'io' | 'talkback' | 'monitor'>, b: Bus): boolean {
  return (
    !DEFAULT_NAME.test(b.name) ||
    b.type === 'mixminus' ||
    b.inserts.length > 0 ||
    s.channels.some((c) => (c.routes ?? []).includes(b.id) || c.sends[b.id]?.on) ||
    s.buses.some((x) => x.output === b.id) ||
    s.io.outputPatch.some((o) => o?.src === b.id) ||
    s.talkback.destinations.includes(b.id) ||
    s.monitor.source === b.id
  );
}

/** Fill in `created` for shows saved before buses had to be created; fader pages drop buses
 *  that don't exist (an emptied "Buses 9-24" page goes away). */
export function withCreatedBuses<T extends Pick<ConsoleState, 'channels' | 'buses' | 'io' | 'talkback' | 'monitor' | 'layers'>>(s: T): T {
  if (s.buses.every((b) => b.created !== undefined)) return s;
  const buses = s.buses.map((b) => (b.created !== undefined ? b : { ...b, created: busInUse(s, b) }));
  const exists = new Set(buses.filter((b) => b.created).map((b) => b.id));
  const layers = s.layers
    .map((l) => ({ ...l, slots: l.slots.map((r) => (r?.kind === 'bus' && !exists.has(r.id) ? null : r)) }))
    .filter((l, i) => !(/^buses \d+-\d+$/i.test(l.name) && l.slots.every((r) => !r) && s.layers[i].slots.some((r) => r)));
  return { ...s, buses, layers: layers.length ? layers : s.layers };
}

export const isCreated = (b: Bus) => b.created !== false;
export const createdBuses = (s: Pick<ConsoleState, 'buses'>) => s.buses.filter(isCreated);
/** Buses you can route / send to (created, and not automatic mix-minus). */
export const routableBuses = (s: Pick<ConsoleState, 'buses'>) => s.buses.filter((b) => isCreated(b) && b.type !== 'mixminus');

const ROLE_DEFAULTS: Record<BusRole, Partial<Bus>> = {
  group: { output: 'main', color: '#46a758' },
  aux: { output: 'none', color: '#0090ff' },
  fx: { output: 'main', color: '#6e56cf' },
  matrix: { output: 'none', color: '#12a594' },
};

/** Create the next free bus (adds it to the first fader page called "Buses" that has room). */
export function createBus(s: ConsoleState, role: BusRole, name?: string): { patch: Partial<ConsoleState>; id: string | null } {
  const free = s.buses.find((b) => !isCreated(b));
  if (!free) return { patch: {}, id: null };
  const n = s.buses.filter(isCreated).filter((b) => b.role === role).length + 1;
  const label = name ?? `${BUS_ROLES.find((r) => r.id === role)!.label.split(' ')[0]} ${n}`;
  const bus: Bus = { ...free, ...ROLE_DEFAULTS[role], created: true, role, type: 'aux', name: label, faderDb: 0, mute: false, inserts: [] };
  const layers = s.layers.slice();
  const li = layers.findIndex((l) => /^buses$/i.test(l.name) && l.slots.slice(0, LAYER_SLOTS - 1).includes(null));
  if (li >= 0 && !layers.some((l) => l.slots.some((r) => r?.kind === 'bus' && r.id === bus.id))) {
    const slots = layers[li].slots.slice();
    slots[slots.indexOf(null)] = { kind: 'bus', id: bus.id };
    layers[li] = { ...layers[li], slots };
  }
  return { patch: { buses: s.buses.map((b) => (b.id === bus.id ? bus : b)), layers }, id: bus.id };
}

/** Remove a bus: everything that pointed at it lets go (sends, assignments, outputs, patch). */
export function deleteBus(s: ConsoleState, id: string): Partial<ConsoleState> {
  return {
    buses: s.buses.map((b) =>
      b.id === id
        ? { ...b, created: false, role: undefined, name: `Bus ${id.slice(3)}`, inserts: [], output: 'main' as const, type: 'aux' as const, mixMinusExclude: undefined }
        : b.output === id ? { ...b, output: 'none' as const } : b,
    ),
    channels: s.channels.map((c) => {
      if (!c.sends[id] && !(c.routes ?? []).includes(id)) return c;
      const { [id]: _gone, ...sends } = c.sends;
      return { ...c, sends, routes: (c.routes ?? []).filter((x) => x !== id) };
    }),
    io: { ...s.io, outputPatch: s.io.outputPatch.map((o) => (o?.src === id ? null : o)) },
    talkback: { ...s.talkback, destinations: s.talkback.destinations.filter((x) => x !== id) },
    monitor: s.monitor.source === id ? { ...s.monitor, source: 'main' } : s.monitor,
    layers: s.layers.map((l) => ({ ...l, slots: l.slots.map((r) => (r?.kind === 'bus' && r.id === id ? null : r)) })),
  };
}
