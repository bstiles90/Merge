// Plugin descriptors. The console only knows about plugins through this format:
// an id, a vendor/format, and a flat list of automatable parameters. That is the
// same shape VST3 / AU / SoundGrid expose, so a native host can register real
// third-party plugins into the same registry and the UI (generic editor, scenes,
// key assignments) keeps working unchanged.

export type PluginFormat = 'builtin' | 'vst3' | 'au' | 'soundgrid';

export interface PluginParam {
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
  unit?: string;
  /** display/drag curve */
  scale?: 'linear' | 'log';
  step?: number;
}

export interface PluginDescriptor {
  id: string;
  name: string;
  vendor: string;
  format: PluginFormat;
  /** 'Dynamics' | 'EQ' | 'Time' | 'Reverb' | 'Utility' for built-ins; whatever the plugin reports otherwise */
  category: string;
  /** built-ins run in the browser engine; everything else needs the native engine */
  native?: boolean;
  params: PluginParam[];
}

export const BUILTIN_PLUGINS: PluginDescriptor[] = [
  {
    id: 'builtin.delay',
    name: 'Stereo Delay',
    vendor: 'Merge',
    format: 'builtin',
    category: 'Time',
    params: [
      { id: 'time', name: 'Time', min: 1, max: 2000, default: 350, unit: 'ms', scale: 'log' },
      { id: 'feedback', name: 'Feedback', min: 0, max: 95, default: 35, unit: '%' },
      { id: 'mix', name: 'Mix', min: 0, max: 100, default: 30, unit: '%' },
    ],
  },
  {
    id: 'builtin.reverb',
    name: 'Plate Reverb',
    vendor: 'Merge',
    format: 'builtin',
    category: 'Reverb',
    params: [
      { id: 'decay', name: 'Decay', min: 0.2, max: 8, default: 1.8, unit: 's', scale: 'log' },
      { id: 'predelay', name: 'Pre-delay', min: 0, max: 200, default: 20, unit: 'ms' },
      { id: 'mix', name: 'Mix', min: 0, max: 100, default: 25, unit: '%' },
    ],
  },
  {
    id: 'builtin.limiter',
    name: 'Brickwall Limiter',
    vendor: 'Merge',
    format: 'builtin',
    category: 'Dynamics',
    params: [
      { id: 'ceiling', name: 'Ceiling', min: -12, max: 0, default: -1, unit: 'dB', step: 0.1 },
      { id: 'drive', name: 'Drive', min: 0, max: 18, default: 0, unit: 'dB', step: 0.1 },
      { id: 'release', name: 'Release', min: 10, max: 1000, default: 100, unit: 'ms', scale: 'log' },
    ],
  },
  {
    id: 'builtin.deesser',
    name: 'De-esser',
    vendor: 'Merge',
    format: 'builtin',
    category: 'Dynamics',
    params: [
      { id: 'freq', name: 'Freq', min: 3000, max: 12000, default: 6500, unit: 'Hz', scale: 'log' },
      { id: 'threshold', name: 'Threshold', min: -60, max: 0, default: -30, unit: 'dB' },
      { id: 'range', name: 'Range', min: 0, max: 18, default: 6, unit: 'dB' },
    ],
  },
  {
    id: 'builtin.geq',
    name: 'Tilt EQ',
    vendor: 'Merge',
    format: 'builtin',
    category: 'EQ',
    params: [
      { id: 'tilt', name: 'Tilt', min: -6, max: 6, default: 0, unit: 'dB', step: 0.1 },
      { id: 'pivot', name: 'Pivot', min: 300, max: 3000, default: 1000, unit: 'Hz', scale: 'log' },
      { id: 'output', name: 'Output', min: -12, max: 12, default: 0, unit: 'dB', step: 0.1 },
    ],
  },
  {
    id: 'builtin.width',
    name: 'Stereo Width',
    vendor: 'Merge',
    format: 'builtin',
    category: 'Utility',
    params: [{ id: 'width', name: 'Width', min: 0, max: 200, default: 100, unit: '%' }],
  },
];

const registry = new Map<string, PluginDescriptor>(BUILTIN_PLUGINS.map((p) => [p.id, p]));

const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

export function registerPlugin(desc: PluginDescriptor) {
  registry.set(desc.id, desc);
  changed();
}

/** Replace all natively hosted plugins (VST3/AU) with the engine's current list. */
export function setNativePlugins(list: PluginDescriptor[]) {
  for (const [id, d] of registry) if (d.native) registry.delete(id);
  for (const d of list) registry.set(d.id, { ...d, native: true });
  changed();
}

export function onPluginsChange(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export const pluginsVersion = () => version;

export function getPlugin(id: string): PluginDescriptor | undefined {
  return registry.get(id);
}

export function listPlugins(): PluginDescriptor[] {
  return [...registry.values()];
}

export function defaultParams(desc: PluginDescriptor): Record<string, number> {
  return Object.fromEntries(desc.params.map((p) => [p.id, p.default]));
}
