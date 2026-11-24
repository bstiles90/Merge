// Core console data model. This is pure data (serialisable to a show file) and is
// deliberately independent of the audio engine so it can be shared with a native
// engine later.

import type { Automation, Role } from './moments';

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

/** A plugin instance in an insert slot. `pluginId` refers to the plugin registry. */
export interface InsertSlot {
  id: string;
  pluginId: string;
  bypass: boolean;
  params: Record<string, number>;
  /** display name, so a show still reads sensibly on a machine without the plugin */
  pluginName?: string;
  /** opaque plugin state (base64) from a natively hosted plugin, restored on load */
  state?: string;
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
  inserts: InsertSlot[];
  pan: number; // -1..1
  faderDb: number;
  mute: boolean;
  solo: boolean;
  mainAssign: boolean;
  /** output assignment to buses (groups): follows the fader and pan, no send level */
  routes?: BusId[];
  sends: Record<BusId, Send>;
  dcas: DcaId[];
  muteGroups: MuteGroupId[];
  recArm: boolean;
  /** live = source, playback = recorded track (virtual soundcheck) */
  inputMode: 'live' | 'playback';
  recallSafe: boolean;
  /** what this channel is (speaker, lead vocal, band…): show moments act on roles */
  role?: Role;
  /** the mic's own name while the strip is labelled with this week's person ("HH1 · Sarah") */
  baseName?: string;
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
  /** where the bus goes after its fader: Main LR, another bus, or nowhere (physical outputs only) */
  output?: 'main' | 'none' | BusId;
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
  color?: string;
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

/** Two mono channels linked as a stereo pair. */
export interface StereoLink {
  left: ChannelId;
  right: ChannelId;
  /** which settings move together (pan and plugins never do) */
  options: { fader: boolean; mute: boolean; solo: boolean; sends: boolean; groups: boolean; input: boolean };
}

export interface ConsoleState {
  showName: string;
  channels: Channel[];
  /** stereo-linked channel pairs */
  stereoLinks: StereoLink[];
  buses: Bus[];
  main: Main;
  dcas: Dca[];
  muteGroups: MuteGroup[];
  layers: Layer[];
  /** page shown in bank A (and the only bank in single-bank view) */
  currentLayer: string;
  /** view option: one fader bank, or two independent banks (A | B) */
  bankLayout: 'single' | 'split';
  /** page shown in bank B in split view */
  currentLayerB: string;
  /** which bank page keys / Page Next/Prev / number keys act on */
  focusBank: 'A' | 'B';
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
  /** program loudness target (integrated LUFS) for the meter and, later, auto-mastering */
  loudnessTarget: number;
  /** delivery spec for the program true peak (dBTP); the TP meter warns above it */
  truePeakCeiling: number;
  /** show automation: channel-role moments, learned levels, ProPresenter rules */
  automation: Automation;
}
