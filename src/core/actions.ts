// The action registry. Every operation that a user key, hotkey, MIDI message,
// Stream Deck button, macro or remote control can trigger is a named action here.
// Actions are pure: (state, args) -> state. `isOn` drives key LEDs from the real
// console state, so a key lights correctly no matter where the change came from.

import { applyScene, takeSnapshot } from './scenes';
import { fireMoment, undoMoment } from './moments';
import { newId } from './defaults';
import { focusedLayerId, setFocusedLayer } from './layers';
import { services } from './services';
import type { ActionCall, Bus, Channel, ConsoleState } from './types';

export type ArgKind = 'channel' | 'bus' | 'dca' | 'muteGroup' | 'scene' | 'layer' | 'moment' | 'number' | 'boolean';

export interface ArgSpec {
  name: string;
  label: string;
  kind: ArgKind;
  default?: string | number | boolean;
}

export interface ActionDef {
  type: string;
  label: string;
  category: 'Mute' | 'Solo' | 'Fader' | 'Scene' | 'Show' | 'Layer' | 'Monitor' | 'Transport' | 'Plugin';
  args: ArgSpec[];
  run: (s: ConsoleState, a: Record<string, any>) => ConsoleState;
  isOn?: (s: ConsoleState, a: Record<string, any>) => boolean;
}

const mapChannel = (s: ConsoleState, id: string, fn: (c: Channel) => Channel): ConsoleState => ({
  ...s,
  channels: s.channels.map((c) => (c.id === id ? fn(c) : c)),
});
const mapBus = (s: ConsoleState, id: string, fn: (b: Bus) => Bus): ConsoleState => ({
  ...s,
  buses: s.buses.map((b) => (b.id === id ? fn(b) : b)),
});

const sceneStep = (s: ConsoleState, dir: 1 | -1): ConsoleState => {
  if (!s.scenes.length) return s;
  const idx = s.scenes.findIndex((x) => x.id === s.currentScene);
  const nextIdx = idx < 0 ? (dir === 1 ? 0 : s.scenes.length - 1) : idx + dir;
  if (nextIdx < 0 || nextIdx >= s.scenes.length) return s;
  return applyScene(s, s.scenes[nextIdx]);
};

const layerStep = (s: ConsoleState, dir: 1 | -1): ConsoleState => {
  const idx = s.layers.findIndex((l) => l.id === focusedLayerId(s));
  const next = s.layers[(idx + dir + s.layers.length) % s.layers.length];
  return next ? setFocusedLayer(s, next.id) : s;
};

const defs: ActionDef[] = [
  {
    type: 'moment.fire',
    label: 'Show moment',
    category: 'Show',
    args: [{ name: 'moment', label: 'Moment', kind: 'moment', default: 'song' }],
    run: (s, a) => {
      const r = fireMoment(s, String(a.moment));
      const name = s.automation.moments.find((m) => m.id === a.moment)?.name ?? String(a.moment);
      return {
        ...r.state,
        automation: {
          ...r.state.automation,
          lastEvent: { at: Date.now(), moment: String(a.moment), text: `${name}: opened ${r.opened.length}, closed ${r.closed.length}`
            + (r.held.length ? `, held ${r.held.length} changed by hand` : '') + (a.source ? ` (${a.source})` : ' (button)') },
        },
      };
    },
    isOn: (s, a) => s.automation.current === a.moment,
  },
  {
    type: 'moment.undo',
    label: 'Undo last moment',
    category: 'Show',
    args: [],
    run: (s) => {
      if (!s.automation.undo) return s;
      const u = undoMoment(s);
      return { ...u, automation: { ...u.automation, lastEvent: { at: Date.now(), moment: '', text: 'Undid the last moment' } } };
    },
  },
  {
    type: 'automation.arm',
    label: 'Show automation armed (toggle)',
    category: 'Show',
    args: [],
    run: (s) => ({ ...s, automation: { ...s.automation, armed: !s.automation.armed } }),
    isOn: (s) => s.automation.armed,
  },
  {
    type: 'channel.mute.toggle',
    label: 'Channel mute (toggle)',
    category: 'Mute',
    args: [{ name: 'id', label: 'Channel', kind: 'channel' }],
    run: (s, a) => mapChannel(s, a.id, (c) => ({ ...c, mute: !c.mute })),
    isOn: (s, a) => !!s.channels.find((c) => c.id === a.id)?.mute,
  },
  {
    type: 'channel.mute.set',
    label: 'Channel mute (set)',
    category: 'Mute',
    args: [
      { name: 'id', label: 'Channel', kind: 'channel' },
      { name: 'on', label: 'Muted', kind: 'boolean', default: true },
    ],
    run: (s, a) => mapChannel(s, a.id, (c) => ({ ...c, mute: !!a.on })),
    isOn: (s, a) => s.channels.find((c) => c.id === a.id)?.mute === !!a.on,
  },
  {
    type: 'bus.mute.toggle',
    label: 'Bus mute (toggle)',
    category: 'Mute',
    args: [{ name: 'id', label: 'Bus', kind: 'bus' }],
    run: (s, a) => mapBus(s, a.id, (b) => ({ ...b, mute: !b.mute })),
    isOn: (s, a) => !!s.buses.find((b) => b.id === a.id)?.mute,
  },
  {
    type: 'dca.mute.toggle',
    label: 'DCA mute (toggle)',
    category: 'Mute',
    args: [{ name: 'id', label: 'DCA', kind: 'dca' }],
    run: (s, a) => ({ ...s, dcas: s.dcas.map((d) => (d.id === a.id ? { ...d, mute: !d.mute } : d)) }),
    isOn: (s, a) => !!s.dcas.find((d) => d.id === a.id)?.mute,
  },
  {
    type: 'main.mute.toggle',
    label: 'Main mute (toggle)',
    category: 'Mute',
    args: [],
    run: (s) => ({ ...s, main: { ...s.main, mute: !s.main.mute } }),
    isOn: (s) => s.main.mute,
  },
  {
    type: 'muteGroup.toggle',
    label: 'Mute group (toggle)',
    category: 'Mute',
    args: [{ name: 'id', label: 'Mute group', kind: 'muteGroup' }],
    run: (s, a) => ({
      ...s,
      muteGroups: s.muteGroups.map((g) => (g.id === a.id ? { ...g, active: !g.active } : g)),
    }),
    isOn: (s, a) => !!s.muteGroups.find((g) => g.id === a.id)?.active,
  },
  {
    type: 'muteGroup.set',
    label: 'Mute group (set)',
    category: 'Mute',
    args: [
      { name: 'id', label: 'Mute group', kind: 'muteGroup' },
      { name: 'on', label: 'Active', kind: 'boolean', default: true },
    ],
    run: (s, a) => ({
      ...s,
      muteGroups: s.muteGroups.map((g) => (g.id === a.id ? { ...g, active: !!a.on } : g)),
    }),
    isOn: (s, a) => s.muteGroups.find((g) => g.id === a.id)?.active === !!a.on,
  },
  {
    type: 'channel.solo.toggle',
    label: 'Channel solo (toggle)',
    category: 'Solo',
    args: [{ name: 'id', label: 'Channel', kind: 'channel' }],
    run: (s, a) => mapChannel(s, a.id, (c) => ({ ...c, solo: !c.solo })),
    isOn: (s, a) => !!s.channels.find((c) => c.id === a.id)?.solo,
  },
  {
    type: 'solo.clear',
    label: 'Clear all solos',
    category: 'Solo',
    args: [],
    run: (s) => ({
      ...s,
      channels: s.channels.map((c) => (c.solo ? { ...c, solo: false } : c)),
      buses: s.buses.map((b) => (b.solo ? { ...b, solo: false } : b)),
    }),
    isOn: (s) => s.channels.some((c) => c.solo) || s.buses.some((b) => b.solo),
  },
  {
    type: 'channel.fader.set',
    label: 'Set channel fader',
    category: 'Fader',
    args: [
      { name: 'id', label: 'Channel', kind: 'channel' },
      { name: 'db', label: 'Level (dB)', kind: 'number', default: 0 },
    ],
    run: (s, a) => mapChannel(s, a.id, (c) => ({ ...c, faderDb: Number(a.db) <= -90 ? -Infinity : Number(a.db) })),
  },
  {
    type: 'dca.fader.set',
    label: 'Set DCA fader',
    category: 'Fader',
    args: [
      { name: 'id', label: 'DCA', kind: 'dca' },
      { name: 'db', label: 'Level (dB)', kind: 'number', default: 0 },
    ],
    run: (s, a) => ({
      ...s,
      dcas: s.dcas.map((d) => (d.id === a.id ? { ...d, faderDb: Number(a.db) <= -90 ? -Infinity : Number(a.db) } : d)),
    }),
  },
  {
    type: 'scene.recall',
    label: 'Recall scene',
    category: 'Scene',
    args: [{ name: 'id', label: 'Scene', kind: 'scene' }],
    run: (s, a) => {
      const sc = s.scenes.find((x) => x.id === a.id);
      return sc ? applyScene(s, sc) : s;
    },
    isOn: (s, a) => s.currentScene === a.id,
  },
  { type: 'scene.next', label: 'Scene: go next', category: 'Scene', args: [], run: (s) => sceneStep(s, 1) },
  { type: 'scene.prev', label: 'Scene: previous', category: 'Scene', args: [], run: (s) => sceneStep(s, -1) },
  {
    type: 'scene.store',
    label: 'Store new scene',
    category: 'Scene',
    args: [],
    run: (s) => {
      const id = newId('sc');
      return {
        ...s,
        scenes: [...s.scenes, { id, name: `Scene ${s.scenes.length + 1}`, snapshot: takeSnapshot(s) }],
        currentScene: id,
      };
    },
  },
  {
    type: 'layer.select',
    label: 'Select page',
    category: 'Layer',
    args: [{ name: 'id', label: 'Layer', kind: 'layer' }],
    run: (s, a) => setFocusedLayer(s, a.id),
    isOn: (s, a) => focusedLayerId(s) === a.id,
  },
  {
    type: 'view.banks.toggle',
    label: 'Toggle 1 / 2 fader banks',
    category: 'Layer',
    args: [],
    run: (s) => ({ ...s, bankLayout: s.bankLayout === 'split' ? 'single' : 'split', focusBank: 'A' }),
    isOn: (s) => s.bankLayout === 'split',
  },
  {
    type: 'view.bank.focus',
    label: 'Page keys target bank A / B (toggle)',
    category: 'Layer',
    args: [],
    run: (s) => ({ ...s, focusBank: s.focusBank === 'A' ? 'B' : 'A' }),
    isOn: (s) => s.bankLayout === 'split' && s.focusBank === 'B',
  },
  {
    type: 'layer.next',
    label: 'Next page',
    category: 'Layer',
    args: [],
    run: (s) => layerStep(s, 1),
  },
  {
    type: 'layer.prev',
    label: 'Previous page',
    category: 'Layer',
    args: [],
    run: (s) => layerStep(s, -1),
  },
  {
    type: 'talkback.toggle',
    label: 'Talkback',
    category: 'Monitor',
    args: [],
    run: (s) => ({ ...s, talkback: { ...s.talkback, active: !s.talkback.active } }),
    isOn: (s) => s.talkback.active,
  },
  {
    type: 'monitor.dim',
    label: 'Monitor dim',
    category: 'Monitor',
    args: [],
    run: (s) => ({ ...s, monitor: { ...s.monitor, dim: !s.monitor.dim } }),
    isOn: (s) => s.monitor.dim,
  },
  {
    type: 'transport.toggle',
    label: 'Play / stop',
    category: 'Transport',
    args: [],
    run: (s) =>
      s.transport.playing || s.transport.recording
        ? { ...s, transport: { ...s.transport, playing: false, recording: false, position: services.playhead() } }
        : { ...s, transport: { ...s.transport, playing: true } },
    isOn: (s) => s.transport.playing,
  },
  {
    type: 'transport.record',
    label: 'Record (toggle)',
    category: 'Transport',
    args: [],
    run: (s) =>
      s.transport.recording
        ? { ...s, transport: { ...s.transport, recording: false, playing: false, position: services.playhead() } }
        : { ...s, transport: { ...s.transport, recording: true, playing: true } },
    isOn: (s) => s.transport.recording,
  },
  {
    type: 'transport.stop',
    label: 'Stop',
    category: 'Transport',
    args: [],
    run: (s) => ({ ...s, transport: { ...s.transport, playing: false, recording: false, position: services.playhead() } }),
  },
  {
    type: 'transport.rtz',
    label: 'Return to zero',
    category: 'Transport',
    args: [],
    run: (s) => ({ ...s, transport: { ...s.transport, position: 0 } }),
  },
  {
    type: 'marker.add',
    label: 'Add marker',
    category: 'Transport',
    args: [],
    run: (s) => {
      const t = services.playhead();
      return { ...s, markers: [...s.markers, { id: newId('mk'), time: t, label: `M${s.markers.length + 1}` }] };
    },
  },
  {
    type: 'channel.insert.bypass',
    label: 'Insert bypass (toggle)',
    category: 'Plugin',
    args: [
      { name: 'id', label: 'Channel', kind: 'channel' },
      { name: 'slot', label: 'Slot # (1-based)', kind: 'number', default: 1 },
    ],
    run: (s, a) =>
      mapChannel(s, a.id, (c) => ({
        ...c,
        inserts: c.inserts.map((ins, i) => (i === Number(a.slot) - 1 ? { ...ins, bypass: !ins.bypass } : ins)),
      })),
    isOn: (s, a) => !!s.channels.find((c) => c.id === a.id)?.inserts[Number(a.slot) - 1]?.bypass,
  },
];

export const ACTIONS = new Map(defs.map((d) => [d.type, d]));

export function runAction(s: ConsoleState, call: ActionCall): ConsoleState {
  const def = ACTIONS.get(call.type);
  if (!def) {
    console.warn('Unknown action', call.type);
    return s;
  }
  return def.run(s, call.args);
}

export function runActions(s: ConsoleState, calls: ActionCall[]): ConsoleState {
  return calls.reduce(runAction, s);
}

/** A key is lit if every action that can report state reports "on". */
export function keyIsOn(s: ConsoleState, calls: ActionCall[]): boolean | undefined {
  const states = calls
    .map((c) => {
      const def = ACTIONS.get(c.type);
      return def?.isOn ? def.isOn(s, c.args) : undefined;
    })
    .filter((x): x is boolean => x !== undefined);
  if (!states.length) return undefined;
  return states.every(Boolean);
}

export function describeAction(s: ConsoleState, call: ActionCall): string {
  const def = ACTIONS.get(call.type);
  if (!def) return call.type;
  const parts = def.args.map((a) => {
    const v = call.args[a.name];
    switch (a.kind) {
      case 'channel':
        return s.channels.find((c) => c.id === v)?.name ?? String(v);
      case 'bus':
        return s.buses.find((c) => c.id === v)?.name ?? String(v);
      case 'dca':
        return s.dcas.find((c) => c.id === v)?.name ?? String(v);
      case 'muteGroup':
        return s.muteGroups.find((c) => c.id === v)?.name ?? String(v);
      case 'scene':
        return s.scenes.find((c) => c.id === v)?.name ?? String(v);
      case 'layer':
        return s.layers.find((c) => c.id === v)?.name ?? String(v);
      case 'moment':
        return s.automation.moments.find((c) => c.id === v)?.name ?? String(v);
      default:
        return `${a.label}: ${v}`;
    }
  });
  return parts.length ? `${def.label} — ${parts.join(', ')}` : def.label;
}
