// Core console data model. This is pure data (serialisable to a show file) and is
// deliberately independent of the audio engine so it can be shared with a native
// engine later.

export type ChannelId = string;
export type BusId = string;
export type DcaId = string;
export type MuteGroupId = string;

export type SourceKind = 'none' | 'tone' | 'noise' | 'speech' | 'input' | 'playback';

export interface SourceConfig {
  kind: SourceKind;
  /** tone frequency */
  freq: number;
  /** live input: device id + channel index on that device */
  deviceId?: string;
  deviceChannel?: number;
}

export type EqBandType = 'lowshelf' | 'peaking' | 'highshelf';
export interface EqBand {
  type: EqBandType;
  freq: number;
  gainDb: number;
  q: number;
}

export interface CompSettings {
  on: boolean;
  threshold: number;
  ratio: number;
  attack: number;
  release: number;
  makeupDb: number;
}

export interface GateSettings {
  on: boolean;
  threshold: number;
  rangeDb: number;
  attack: number;
  release: number;
}

/** A plugin instance in an insert slot. `pluginId` refers to the plugin registry. */
export interface InsertSlot {
  id: string;
  pluginId: string;
  bypass: boolean;
  params: Record<string, number>;
}

export interface Send {
  on: boolean;
  levelDb: number;
  pre: boolean;
}

export interface Channel {
  id: ChannelId;
  name: string;
  color: string;
  source: SourceConfig;
  gainDb: number;
  phaseInvert: boolean;
  delayMs: number;
  hpf: { on: boolean; freq: number };
  gate: GateSettings;
  eq: { on: boolean; bands: EqBand[] };
  comp: CompSettings;
  inserts: InsertSlot[];
  pan: number; // -1..1
  faderDb: number;
  mute: boolean;
  solo: boolean;
  mainAssign: boolean;
  sends: Record<BusId, Send>;
  dcas: DcaId[];
  muteGroups: MuteGroupId[];
  recArm: boolean;
  /** live = source, playback = recorded track (virtual soundcheck) */
  inputMode: 'live' | 'playback';
  recallSafe: boolean;
}

export type BusType = 'aux' | 'mixminus';
export interface Bus {
  id: BusId;
  name: string;
  color: string;
  type: BusType;
  /** for mix-minus: channel removed from the main-mix feed */
  mixMinusExclude?: ChannelId;
  faderDb: number;
  mute: boolean;
  solo: boolean;
  delayMs: number;
  inserts: InsertSlot[];
  muteGroups: MuteGroupId[];
  recallSafe: boolean;
}

export interface Main {
  faderDb: number;
  mute: boolean;
  delayMs: number;
  inserts: InsertSlot[];
}

export interface Dca {
  id: DcaId;
  name: string;
  color: string;
  faderDb: number;
  mute: boolean;
}

export interface MuteGroup {
  id: MuteGroupId;
  name: string;
  active: boolean;
}

export type StripRef =
  | { kind: 'channel'; id: ChannelId }
  | { kind: 'bus'; id: BusId }
  | { kind: 'dca'; id: DcaId }
  | { kind: 'main' };

export interface Layer {
  id: string;
  name: string;
  slots: (StripRef | null)[];
}

/** A call into the action registry, e.g. { type: 'muteGroup.toggle', args: { id: 'mg1' } } */
export interface ActionCall {
  type: string;
  args: Record<string, string | number | boolean>;
}

export interface UserKey {
  id: string;
  label: string;
  color: string;
  /** latch: press toggles / fires. momentary: press fires, release fires again (undo). */
  mode: 'latch' | 'momentary';
  actions: ActionCall[];
  hotkey?: string; // e.g. "F13", "Shift+1"
  midi?: { status: number; data1: number }; // note-on / cc learn
}

export interface MidiFaderMap {
  target: StripRef;
  status: number; // 0xB0 | ch
  data1: number; // CC number
}

export interface MonitorState {
  source: 'main' | BusId;
  levelDb: number;
  dim: boolean;
  dimDb: number;
  /** solo mode: PFL is pre-fader, AFL post-fader */
  soloMode: 'pfl' | 'afl';
}

/** What feeds a physical output channel. */
export interface OutputSource {
  src: 'main' | 'monitor' | BusId;
  side: 0 | 1; // L / R
}

export interface IoState {
  /** audio interface for outputs (Dante Virtual Soundcard, SoundGrid driver, CoreAudio/ASIO device...) */
  outputDeviceId?: string;
  /** output patch: index = physical output channel */
  outputPatch: (OutputSource | null)[];
}

export interface Talkback {
  active: boolean;
  deviceId?: string;
  deviceChannel: number;
  levelDb: number;
  destinations: BusId[];
}

export type SceneScope = {
  channels: boolean;
  buses: boolean;
  main: boolean;
  dcas: boolean;
  muteGroups: boolean;
};

export interface MixSnapshot {
  channels: Channel[];
  buses: Bus[];
  main: Main;
  dcas: Dca[];
  muteGroups: MuteGroup[];
}

export interface Scene {
  id: string;
  name: string;
  snapshot: MixSnapshot;
}

export interface Clip {
  id: string;
  trackId: string; // channel id, or 'pgm' for program record
  name: string;
  start: number; // seconds on timeline
  offset: number; // seconds into the buffer
  duration: number;
  bufferId: string;
  channels: number;
}

export interface Marker {
  id: string;
  time: number;
  label: string;
}

export interface TransportState {
  playing: boolean;
  recording: boolean;
  position: number; // seconds, updated when stopped/seeked
  recordProgram: boolean;
}

export interface ConsoleState {
  showName: string;
  channels: Channel[];
  buses: Bus[];
  main: Main;
  dcas: Dca[];
  muteGroups: MuteGroup[];
  layers: Layer[];
  currentLayer: string;
  selected: StripRef | null;
  userKeys: UserKey[];
  /** keys currently in the "on" state (latch LED / momentary held) */
  keyStates: Record<string, boolean>;
  scenes: Scene[];
  currentScene: string | null;
  sceneScope: SceneScope;
  monitor: MonitorState;
  io: IoState;
  talkback: Talkback;
  midiFaders: MidiFaderMap[];
  clips: Clip[];
  markers: Marker[];
  transport: TransportState;
}
