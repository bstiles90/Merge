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
  /** stereo channels: the right input (defaults to the one after deviceChannel) */
  deviceChannelR?: number;
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
  /** scene recall leaves this plugin (and its settings) as it is */
  recallSafe?: boolean;
}

/** What a strip's recall safe can protect (LV1-style), down to individual plugin slots. */
export type SafePart = 'input' | 'fader' | 'mute' | 'pan' | 'sends' | 'routing' | 'groups' | 'inserts' | 'name';
export type SafeSet = Partial<Record<SafePart, boolean>>;

/** Where a send taps the channel:
 *  input = after gain only (before delay and every plugin)
 *  pre   = pre-fader, after the rack (or after a chosen plugin: tapAfter)
 *  post  = after the rack and the fader
 *  psp   = post-fader and post-pan */
export type SendTap = 'input' | 'pre' | 'post' | 'psp';

export interface Send {
  on: boolean;
  levelDb: number;
  /** true for input/pre taps (kept in step with `tap` for older code and shows) */
  pre: boolean;
  tap?: SendTap;
  /** pre tap only: the insert slot id the tap comes after (missing = after the whole rack) */
  tapAfter?: string;
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
  pan: number; // -1..1 (balance on a stereo channel)
  /** stereo channel: two inputs (L/R) through the whole strip; pan works as balance */
  stereo?: boolean;
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
  /** whole strip safe from scene recalls */
  recallSafe: boolean;
  /** parts of the strip safe from scene recalls */
  safe?: SafeSet;
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
  safe?: SafeSet;
  /** where the bus goes after its fader: Main LR, another bus, or nowhere (physical outputs only) */
  output?: 'main' | 'none' | BusId;
  /** only created buses appear in routing / sends / outputs (64 slots are available) */
  created?: boolean;
  /** what the bus is for (label + defaults when it's created): group, aux / IEM, FX return, matrix / feed */
  role?: BusRole;
}

export type BusRole = 'group' | 'aux' | 'fx' | 'matrix';

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

/** One step of a macro. Fader moves run alongside the next steps unless `wait` is set. */
export type MacroStep =
  | { kind: 'action'; call: ActionCall }
  | { kind: 'fade'; target: StripRef; db: number; sec: number; wait?: boolean }
  | { kind: 'wait'; sec: number };

/** A user macro: a named, timed sequence (like a ProPresenter macro), run from a user key. */
export interface Macro {
  id: string;
  name: string;
  color: string;
  steps: MacroStep[];
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
  /** fade time on recall (ms): faders, sends, pan and gain glide; 0 / missing = instant */
  fadeMs?: number;
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
  /** meters turn from green to yellow here (dBFS): -10 like Waves LV1, -18 like dLive / Wing / M32 / CL */
  meterYellowDb?: number;
  /** user macros (timed multi-step sequences) */
  macros?: Macro[];
  /** macros running right now (not saved) */
  macrosRunning?: string[];
}
