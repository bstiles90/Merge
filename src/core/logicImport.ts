// Logic Pro project → Merge show.
//
// A .logicx package keeps its mix in Alternatives/<n>/ProjectData: a 24-byte header, then
// chunks with a 36-byte header (4-char tag stored reversed at 0, body length u64 at 28).
// What we read:
//   AuCO  one channel strip: type, fader, pan, output bus, aux input bus, mono / stereo
//   AuCU  what sits in a strip's slots: inserts (slots 7-18, the AU's own ClassInfo state as
//         an XML plist, which hosts restore directly) and sends (slots 0-6, 76-byte bodies)
//   Envi  the names of the strips
// Logic hosts Audio Units only, so every plugin comes across as an AU (aucode:type,subtype,manufacturer).

import { LAYER_SLOTS, PALETTE, defaultState, makeBus, makeChannel } from './defaults';
import { useConsole } from './store';
import type { Bus, BusId, Channel, ConsoleState, InsertSlot, Layer, StripRef } from './types';

export type LogicStripKind = 'audio' | 'aux' | 'output' | 'master' | 'other';

export interface LogicPlugin {
  slot: number;
  /** Logic's short name (up to 11 characters) */
  name: string;
  type: string;
  subtype: string;
  manufacturer: string;
  /** the AU ClassInfo plist (XML), as Logic saved it */
  state: Uint8Array;
}

export interface LogicSend {
  slot: number;
  bus: number;
  /** Logic's 0-127 level (90 = 0 dB) */
  level: number;
}

export interface LogicStrip {
  index: number;
  kind: LogicStripKind;
  name: string;
  fader: number;
  pan: number;
  /** 0 = Stereo Out, n = Bus n */
  output: number;
  /** aux strips: the bus they listen to */
  input?: number;
  stereo: boolean;
  plugins: LogicPlugin[];
  sends: LogicSend[];
}

export interface LogicProject {
  strips: LogicStrip[];
}

const KINDS: Record<number, LogicStripKind> = { 0x40: 'audio', 0x42: 'aux', 0x4c: 'output', 0x46: 'master' };
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');
const fourCC = (n: number) => String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

function indexOf(hay: Uint8Array, needle: string, from = 0): number {
  const n = Array.from(needle, (c) => c.charCodeAt(0));
  outer: for (let i = from; i <= hay.length - n.length; i++) {
    for (let k = 0; k < n.length; k++) if (hay[i + k] !== n[k]) continue outer;
    return i;
  }
  return -1;
}

interface Chunk {
  tag: string;
  head: DataView;
  body: Uint8Array;
}

function* chunks(d: Uint8Array): Generator<Chunk> {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let i = 24;
  while (i + 36 <= d.length) {
    const tag = latin1(d.subarray(i, i + 4));
    if (!/^[A-Za-z]{4}$/.test(tag)) return;
    const len = v.getUint32(i + 28, true) + v.getUint32(i + 32, true) * 2 ** 32;
    yield { tag: tag.split('').reverse().join(''), head: new DataView(d.buffer, d.byteOffset + i, 36), body: d.subarray(i + 36, i + 36 + len) };
    i += 36 + len;
  }
}

/** Read the mix out of a Logic ProjectData file. */
export function readLogicProject(data: Uint8Array): LogicProject {
  if (data.length < 64 || indexOf(data.subarray(24, 64), 'gnoS') < 0) throw new Error('Not a Logic Pro project (ProjectData)');
  const names = new Map<number, string>();
  const strips = new Map<number, LogicStrip>();
  const slots: [number, number, Uint8Array][] = [];
  for (const c of chunks(data)) {
    const b = c.body;
    if (c.tag === 'Envi' && b.length > 162) {
      const n = b[158] | (b[159] << 8);
      const at = 160 + n + (n & 1);
      if (at + 2 > b.length) continue;
      names.set((b[at] | (b[at + 1] << 8)) - 1, latin1(b.subarray(160, 160 + n)));
    } else if (c.tag === 'AuCO' && b.length > 123) {
      const index = c.head.getUint32(14, true);
      if (strips.has(index)) continue;
      const kind = KINDS[b[4]] ?? 'other';
      strips.set(index, {
        index,
        kind,
        name: '',
        fader: b[85],
        pan: b[89],
        output: b[92],
        ...(kind === 'aux' ? { input: b[94] - 4 } : {}),
        stereo: b[123] === 2,
        plugins: [],
        sends: [],
      });
    } else if (c.tag === 'AuCU') {
      slots.push([c.head.getUint32(14, true), c.head.getUint32(18, true), b]);
    }
  }
  for (const [index, slot, b] of slots) {
    const st = strips.get(index);
    if (!st) continue;
    if (slot < 7 && b.length === 76 && b[0] === 0x48) {
      st.sends.push({ slot: b[6], bus: b[20] - 4, level: b[17] });
    } else if (slot >= 7 && slot <= 18) {
      const x = indexOf(b, '<?xml');
      const end = x < 0 ? -1 : indexOf(b, '</plist>', x);
      if (end < 0) continue;
      const xml = b.slice(x, end + 8);
      const text = latin1(xml);
      const int = (k: string) => Number(new RegExp(`<key>${k}</key>\\s*<integer>(-?\\d+)</integer>`).exec(text)?.[1] ?? NaN);
      const [type, subtype, manufacturer] = ['type', 'subtype', 'manufacturer'].map(int);
      if (![type, subtype, manufacturer].every(Number.isFinite)) continue;
      const name = latin1(b.subarray(120, Math.max(120, x - 40))).split('\0')[0].trim();
      st.plugins.push({ slot: slot - 7, name: name || fourCC(subtype), type: fourCC(type), subtype: fourCC(subtype), manufacturer: fourCC(manufacturer), state: xml });
    }
  }
  const out = [...strips.values()].sort((a, b) => a.index - b.index);
  for (const s of out) {
    s.name = names.get(s.index) ?? '';
    s.plugins.sort((a, b) => a.slot - b.slot);
    s.sends.sort((a, b) => a.slot - b.slot);
  }
  return { strips: out };
}

/** Logic's 0-127 fader value in dB (127 = +6, 90 = 0, 0 = off). */
export function logicDb(v: number): number {
  if (v <= 0) return -Infinity;
  return Math.round((40 * Math.log10(v / 127) + 6) * 10) / 10;
}

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const MAX_INSERTS = 8;

export interface LogicImportReport {
  channels: number;
  buses: number;
  plugins: number;
  sends: number;
  /** what didn't come across (plugins past Merge's 8 slots) */
  dropped: string[];
}

let seq = 0;
const insertId = () => `ins_lg${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function inserts(p: LogicPlugin[], where: string, dropped: string[]): InsertSlot[] {
  if (p.length > MAX_INSERTS) dropped.push(...p.slice(MAX_INSERTS).map((x) => `${where}: ${x.name}`));
  return p.slice(0, MAX_INSERTS).map((x) => ({
    id: insertId(),
    pluginId: `aucode:${x.type},${x.subtype},${x.manufacturer}`,
    pluginName: x.name,
    bypass: false,
    params: {},
    state: 'b64:' + b64(x.state), // standard base64 (the engine's own state strings are JUCE's)
  }));
}

const pages = (name: string, refs: StripRef[], color: string, idBase: string): Layer[] => {
  const out: Layer[] = [];
  const per = LAYER_SLOTS - 1; // the last slot of every page is Main LR
  for (let i = 0; i < refs.length; i += per) {
    const slots: (StripRef | null)[] = refs.slice(i, i + per);
    while (slots.length < per) slots.push(null);
    slots.push({ kind: 'main' });
    const range = refs.length > per ? ` ${i + 1}-${Math.min(refs.length, i + per)}` : '';
    out.push({ id: `${idBase}${out.length + 1}`, name: `${name}${range}`, color, slots });
  }
  return out;
};

/** Build a Merge show from a Logic project. Live inputs are patched in order (a stereo track
 *  takes two); the interface, output patch and talkback set-up of `current` are kept. */
export function logicToShow(p: LogicProject, showName: string, current?: ConsoleState): { show: ConsoleState; report: LogicImportReport } {
  const d = defaultState();
  const dropped: string[] = [];
  const auxes = p.strips.filter((s) => s.kind === 'aux' && s.input !== undefined && s.input > 0);
  const tracks = p.strips.filter((s) => s.kind === 'audio' && s.name && s.name !== 'Preview');
  const stereoOut = p.strips.find((s) => s.kind === 'output' && s.output === 0) ?? p.strips.find((s) => s.kind === 'output');

  // Logic bus number -> Merge bus
  const busFor = new Map<number, BusId>();
  auxes.slice(0, d.buses.length).forEach((a, i) => busFor.set(a.input!, `bus${i + 1}`));
  const fedByRoute = new Set<BusId>();
  for (const s of [...tracks, ...auxes]) if (s.output && busFor.has(s.output)) fedByRoute.add(busFor.get(s.output)!);

  let sends = 0;
  const sendsOf = (s: LogicStrip): Channel['sends'] => {
    const out: Channel['sends'] = {};
    for (const x of s.sends) {
      const id = busFor.get(x.bus);
      if (!id) continue;
      out[id] = { on: true, levelDb: logicDb(x.level), pre: false, tap: 'post' };
      sends++;
    }
    return out;
  };

  const busColor = new Map<BusId, string>();
  const buses: Bus[] = d.buses.map((def, i) => {
    const a = auxes[i];
    if (!a) return { ...makeBus(i + 1), created: false, output: 'main' };
    const id = def.id;
    const role = fedByRoute.has(id) ? 'group' : 'fx';
    const color = PALETTE[i % 8];
    busColor.set(id, color);
    return {
      ...makeBus(i + 1),
      name: a.name || `Bus ${a.input}`,
      color,
      created: true,
      role,
      faderDb: logicDb(a.fader),
      inserts: inserts(a.plugins, a.name, dropped),
      output: a.output === 0 ? 'main' : busFor.get(a.output) ?? 'none',
    };
  });
  // aux strips' own sends (Lead Vocal Level -> the vocal verbs, Mix Bus -> Mixbus PLL)
  auxes.slice(0, buses.length).forEach((a, i) => {
    if (a.sends.length) buses[i].sends = sendsOf(a);
  });

  let input = 0;
  const channels: Channel[] = tracks.map((t, i) => {
    const c = makeChannel(i + 1);
    const route = t.output ? busFor.get(t.output) : undefined;
    const ch: Channel = {
      ...c,
      name: t.name,
      color: (route && busColor.get(route)) ?? PALETTE[8],
      stereo: t.stereo || undefined,
      source: { kind: 'input', freq: 1000, deviceChannel: input, ...(t.stereo ? { deviceChannelR: input + 1 } : {}) },
      faderDb: logicDb(t.fader),
      pan: Math.max(-1, Math.min(1, (t.pan - 64) / 63)),
      mainAssign: t.output === 0,
      routes: route ? [route] : [],
      sends: sendsOf(t),
      inserts: inserts(t.plugins, t.name, dropped),
    };
    input += t.stereo ? 2 : 1;
    return ch;
  });

  const created = buses.filter((b) => b.created);
  const layers = [
    ...pages('Inputs', channels.map((c) => ({ kind: 'channel', id: c.id })), PALETTE[8], 'LGc'),
    ...pages('Buses', created.map((b) => ({ kind: 'bus', id: b.id })), PALETTE[5], 'LGb'),
  ];
  const keep = current ?? d;
  const exists = new Set(created.map((b) => b.id));
  const show: ConsoleState = {
    ...d,
    showName,
    channels,
    stereoLinks: [],
    buses,
    main: { ...d.main, faderDb: stereoOut ? logicDb(stereoOut.fader) : 0, inserts: stereoOut ? inserts(stereoOut.plugins, 'Stereo Out', dropped) : [] },
    dcas: d.dcas.map((x, i) => ({ ...x, name: `DCA ${i + 1}`, color: PALETTE[6] })),
    muteGroups: d.muteGroups.map((x, i) => ({ ...x, name: `Mute ${i + 1}` })),
    layers,
    currentLayer: layers[0].id,
    currentLayerB: (layers.find((l) => l.id.startsWith('LGb')) ?? layers[0]).id,
    selected: channels[0] ? { kind: 'channel', id: channels[0].id } : null,
    userKeys: d.userKeys.filter((k) => k.actions.every((a) => !String(a.args?.id ?? '').match(/^(ch|bus|mg|dca)\d/))),
    io: { ...keep.io, outputPatch: keep.io.outputPatch.map((o) => (o && o.src.startsWith('bus') && !exists.has(o.src) ? null : o)) },
    talkback: { ...keep.talkback, destinations: keep.talkback.destinations.filter((b) => exists.has(b)) },
    monitor: { ...keep.monitor, source: exists.has(keep.monitor.source) ? keep.monitor.source : 'main' },
  };
  const plugins = channels.reduce((n, c) => n + c.inserts.length, 0) + created.reduce((n, b) => n + b.inserts.length, 0) + show.main.inserts.length;
  return { show, report: { channels: channels.length, buses: created.length, plugins, sends, dropped } };
}

/** Replace the current show with one made from a Logic ProjectData file; returns a one-line summary. */
export function importLogic(data: Uint8Array, name: string): string {
  const st = useConsole.getState();
  const { show, report } = logicToShow(readLogicProject(data), name || 'Logic import', st);
  st.loadShow(show);
  const r = report;
  return `Imported ${name}: ${r.channels} channels, ${r.buses} buses, ${r.plugins} plugins, ${r.sends} sends` + (r.dropped.length ? `. Not imported: ${r.dropped.join(', ')}` : '');
}
