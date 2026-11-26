import type {
  Bus,
  Channel,
  ConsoleState,
  Dca,
  Layer,
  MuteGroup,
  StripRef,
  UserKey,
} from './types';

export const NUM_CHANNELS = 32;
/** Every bus can be a group, an aux/FX send or a feed: routing decides (like Logic's 64 buses). */
export const NUM_BUSES = 64;
export const NUM_DCAS = 8;
export const NUM_MUTE_GROUPS = 8;
export const LAYER_SLOTS = 16;
export const NUM_USER_KEYS = 16;

export const PALETTE = [
  '#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#6e56cf', '#d6409f',
  '#8d8d8d', '#a18072',
];

let uid = 0;
export function newId(prefix: string): string {
  uid += 1;
  return `${prefix}_${Date.now().toString(36)}${uid.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function makeChannel(n: number): Channel {
  return {
    id: `ch${n}`,
    name: `Ch ${n}`,
    color: PALETTE[8],
    source: { kind: 'none', freq: 1000 },
    gainDb: 0,
    phaseInvert: false,
    delayMs: 0,
    inserts: [],
    pan: 0,
    faderDb: -Infinity,
    mute: false,
    solo: false,
    mainAssign: true,
    routes: [],
    sends: {},
    dcas: [],
    muteGroups: [],
    recArm: false,
    inputMode: 'live',
    recallSafe: false,
  };
}

export function makeBus(n: number): Bus {
  return {
    id: `bus${n}`,
    name: `Bus ${n}`,
    color: PALETTE[5],
    type: 'aux',
    faderDb: 0,
    mute: false,
    solo: false,
    delayMs: 0,
    inserts: [],
    muteGroups: [],
    recallSafe: false,
    output: 'main',
  };
}

export function makeDca(n: number): Dca {
  return { id: `dca${n}`, name: `DCA ${n}`, color: PALETTE[6], faderDb: 0, mute: false };
}

export function makeMuteGroup(n: number): MuteGroup {
  return { id: `mg${n}`, name: `Mute ${n}`, active: false };
}

const ch = (n: number): StripRef => ({ kind: 'channel', id: `ch${n}` });
const bus = (n: number): StripRef => ({ kind: 'bus', id: `bus${n}` });
const dca = (n: number): StripRef => ({ kind: 'dca', id: `dca${n}` });

function pad(slots: (StripRef | null)[]): (StripRef | null)[] {
  const out = slots.slice(0, LAYER_SLOTS);
  while (out.length < LAYER_SLOTS) out.push(null);
  return out;
}

export function defaultLayers(): Layer[] {
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  return [
    { id: 'L1', name: 'Show', color: PALETTE[6], slots: pad([ch(1), ch(2), ch(3), ch(4), null, ch(5), ch(6), ch(7), null, dca(1), dca(2), dca(3), null, bus(7), bus(1), { kind: 'main' }]) },
    { id: 'L2', name: 'Inputs 1-16', color: PALETTE[8], slots: pad(range(1, 16).map(ch)) },
    { id: 'L3', name: 'Inputs 17-32', color: PALETTE[8], slots: pad(range(17, 32).map(ch)) },
    // new buses are added to this page as they're created
    { id: 'L4', name: 'Buses', color: PALETTE[5], slots: pad([bus(1), bus(7), bus(8), null, null, null, null, null, null, null, null, null, null, null, null, { kind: 'main' }]) },
    { id: 'L5', name: 'DCAs', color: PALETTE[7], slots: pad([...range(1, 8).map(dca), null, null, null, null, null, null, null, { kind: 'main' }]) },
  ];
}

function key(id: number, label: string, color: string, actions: UserKey['actions'], extra: Partial<UserKey> = {}): UserKey {
  return { id: `uk${id}`, label, color, mode: 'latch', actions, ...extra };
}

export function defaultUserKeys(): UserKey[] {
  const keys: UserKey[] = [
    key(1, 'Hosts\nMute', PALETTE[0], [{ type: 'muteGroup.toggle', args: { id: 'mg1' } }], { hotkey: 'F1' }),
    key(2, 'Audience\nMute', PALETTE[0], [{ type: 'muteGroup.toggle', args: { id: 'mg2' } }], { hotkey: 'F2' }),
    key(3, 'Playback\nMute', PALETTE[0], [{ type: 'muteGroup.toggle', args: { id: 'mg3' } }], { hotkey: 'F3' }),
    key(4, 'Cough\nHost 1', PALETTE[1], [{ type: 'channel.mute.toggle', args: { id: 'ch1' } }], { mode: 'momentary', hotkey: 'F4' }),
    key(5, 'Talkback', PALETTE[2], [{ type: 'talkback.toggle', args: {} }], { mode: 'momentary', hotkey: 'F5' }),
    key(6, 'Scene\nPrev', PALETTE[5], [{ type: 'scene.prev', args: {} }], { hotkey: 'F6' }),
    key(7, 'Scene\nGo Next', PALETTE[3], [{ type: 'scene.next', args: {} }], { hotkey: 'F7' }),
    key(8, 'Clear\nSolo', PALETTE[2], [{ type: 'solo.clear', args: {} }], { hotkey: 'F8' }),
    key(9, 'Record', PALETTE[0], [{ type: 'transport.record', args: {} }], { hotkey: 'F9' }),
    key(10, 'Play /\nStop', PALETTE[3], [{ type: 'transport.toggle', args: {} }], { hotkey: 'F10' }),
    key(11, 'Marker', PALETTE[2], [{ type: 'marker.add', args: {} }], { hotkey: 'F11' }),
    key(12, 'Dim\nMonitor', PALETTE[5], [{ type: 'monitor.dim', args: {} }], { hotkey: 'F12' }),
    key(13, 'Page\nPrev', PALETTE[6], [{ type: 'layer.prev', args: {} }]),
    key(14, 'Page\nNext', PALETTE[6], [{ type: 'layer.next', args: {} }]),
    key(15, 'All Mics\nOff', PALETTE[0], [
      { type: 'muteGroup.set', args: { id: 'mg1', on: true } },
      { type: 'muteGroup.set', args: { id: 'mg2', on: true } },
    ]),
    key(16, 'Fade Bed\nOut', PALETTE[7], [{ type: 'channel.fader.set', args: { id: 'ch7', db: -90 } }]),
  ];
  return keys;
}

export function defaultState(): ConsoleState {
  const channels = Array.from({ length: NUM_CHANNELS }, (_, i) => makeChannel(i + 1));
  const buses = Array.from({ length: NUM_BUSES }, (_, i) => makeBus(i + 1));
  const dcas = Array.from({ length: NUM_DCAS }, (_, i) => makeDca(i + 1));
  const muteGroups = Array.from({ length: NUM_MUTE_GROUPS }, (_, i) => makeMuteGroup(i + 1));

  // A small broadcast demo show: hosts, guest, a remote guest with mix-minus, music bed.
  const setup: [number, string, string, Channel['source']['kind'], number, string[], string[]][] = [
    [1, 'Host 1', PALETTE[0], 'speech', -12, ['dca1'], ['mg1']],
    [2, 'Host 2', PALETTE[0], 'speech', -12, ['dca1'], ['mg1']],
    [3, 'Guest', PALETTE[1], 'speech', -12, ['dca1'], ['mg1']],
    [4, 'Remote', PALETTE[4], 'speech', -12, ['dca2'], []],
    [5, 'Aud L', PALETTE[3], 'noise', -30, ['dca3'], ['mg2']],
    [6, 'Aud R', PALETTE[3], 'noise', -30, ['dca3'], ['mg2']],
    [7, 'Music Bed', PALETTE[6], 'tone', -30, ['dca3'], ['mg3']],
  ];
  for (const [n, name, color, kind, fader, d, mg] of setup) {
    const c = channels[n - 1];
    c.name = name;
    c.color = color;
    c.source = { kind, freq: kind === 'tone' ? 220 : 1000 };
    c.faderDb = fader;
    c.dcas = d;
    c.muteGroups = mg;
  }
  channels[4].pan = -1;
  channels[5].pan = 1;
  // Host 1 has a different voice than Host 2 for the demo.
  channels[1].source.freq = 1300;
  channels[2].source.freq = 800;
  channels[3].source.freq = 1600;

  dcas[0].name = 'Mics';
  dcas[0].color = PALETTE[0];
  dcas[1].name = 'Remote';
  dcas[1].color = PALETTE[4];
  dcas[2].name = 'FX/Music';
  dcas[2].color = PALETTE[6];

  muteGroups[0].name = 'Hosts';
  muteGroups[1].name = 'Audience';
  muteGroups[2].name = 'Playback';

  // buses 1-8 of the demo are feeds (IEM, mix-minus, stage) that go to outputs, not Main LR
  for (const b of buses.slice(0, 8)) b.output = 'none';
  buses[0].name = 'Host IEM';
  buses[6].name = 'Stream Feed';
  buses[6].color = PALETTE[4];
  buses[6].role = 'aux';
  buses[7].name = 'Stage';
  // the demo's buses: Host IEM, Remote N-1 and Stage exist; the other 61 slots are free for New bus
  buses.forEach((b, i) => (b.created = i === 0 || i === 6 || i === 7));
  buses[0].role = 'aux';
  buses[7].role = 'aux';
  // Host IEM: hosts + remote, pre-fader
  for (const n of [1, 2, 4]) channels[n - 1].sends['bus1'] = { on: true, levelDb: -6, pre: true };

  return {
    showName: 'Untitled Show',
    channels,
    // demo: the audience mic pair is stereo-linked
    stereoLinks: [{ left: 'ch5', right: 'ch6', options: { fader: true, mute: true, solo: true, sends: true, groups: true, input: true } }],
    buses,
    main: { faderDb: 0, mute: false, delayMs: 0, inserts: [] },
    dcas,
    muteGroups,
    layers: defaultLayers(),
    currentLayer: 'L1',
    bankLayout: 'single',
    currentLayerB: 'L2',
    focusBank: 'A',
    selected: { kind: 'channel', id: 'ch1' },
    userKeys: defaultUserKeys(),
    keyStates: {},
    scenes: [],
    currentScene: null,
    sceneScope: { channels: true, buses: true, main: true, dcas: true, muteGroups: true },
    monitor: { source: 'main', levelDb: 0, dim: false, dimDb: -20, soloMode: 'pfl' },
    io: {
      outputPatch: [
        { src: 'monitor', side: 0 },
        { src: 'monitor', side: 1 },
        { src: 'main', side: 0 },
        { src: 'main', side: 1 },
        { src: 'bus1', side: 0 },
        { src: 'bus1', side: 1 },
        { src: 'bus7', side: 0 },
        { src: 'bus7', side: 1 },
      ],
    },
    talkback: { active: false, deviceChannel: 0, levelDb: 0, destinations: ['bus1', 'bus8'] },
    midiFaders: [],
    clips: [],
    markers: [],
    transport: { playing: false, recording: false, position: 0, recordProgram: true },
    loudnessTarget: -11,
    truePeakCeiling: -1,
    meterYellowDb: -10,
  };
}
