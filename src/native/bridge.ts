// Link between the console UI and the native Merge Engine (engine/), over a
// localhost WebSocket. The UI stays the source of truth: it compiles the console
// state into a mix plan and streams it; the engine streams back meters, loudness,
// device info and plugin state. Protocol: engine/PROTOCOL.md.

import { create } from 'zustand';
import { buildMixPlan } from '../core/plan';
import { setNativePlugins, type PluginFormat } from '../core/plugins';
import { stateOnly, useConsole } from '../core/store';
import type { ConsoleState, InsertSlot } from '../core/types';
import type { LoudnessReading, MeterReading } from '../audio/engine';

export const DEFAULT_ENGINE_URL = 'ws://127.0.0.1:18620';

export interface NativeParam {
  id: string;
  name: string;
  value: number; // normalised 0..1
  text: string;
  label: string;
  steps: number;
}

export interface NativeInsert {
  /** instantiating: licence check / activation dialog may be in progress */
  loading?: boolean;
  name?: string;
  latency?: number;
  hasEditor?: boolean;
  editorOpen?: boolean;
  error?: string;
  params: NativeParam[];
}

export interface NativeDevice {
  virtual: boolean;
  deviceType?: string;
  inputDevice?: string;
  outputDevice?: string;
  sampleRate: number;
  bufferSize: number;
  latencyMs?: number;
  inputs: string[];
  outputs: string[];
  sampleRates?: number[];
  bufferSizes?: number[];
  types: { name: string; inputs: string[]; outputs: string[] }[];
}

interface NativeState {
  status: 'off' | 'connecting' | 'connected' | 'error';
  url: string;
  version?: string;
  error?: string;
  device?: NativeDevice;
  scan?: { progress: number; file: string; format?: string };
  scanning: boolean;
  blacklisted: string[];
  pdc: number;
  inserts: Record<string, NativeInsert>;
}

export const useNative = create<NativeState>(() => ({
  status: 'off',
  url: DEFAULT_ENGINE_URL,
  scanning: false,
  blacklisted: [],
  pdc: 0,
  inserts: {},
}));

let ws: WebSocket | null = null;
let unsubscribe: (() => void) | null = null;
let lastPlanJson = '';
let planTimer: ReturnType<typeof setTimeout> | null = null;
let meters = new Map<string, MeterReading>();
let loudness: LoudnessReading = { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, peak: [0, 0] };

export const isNativeConnected = () => useNative.getState().status === 'connected';
export const readNativeMeters = () => meters;
export const readNativeLoudness = () => loudness;

export function sendNative(msg: object) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function schedulePlan() {
  if (planTimer) return;
  planTimer = setTimeout(() => {
    planTimer = null;
    const json = JSON.stringify(buildMixPlan(stateOnly(useConsole.getState())));
    if (json === lastPlanJson) return; // e.g. only UI-only state changed
    lastPlanJson = json;
    if (ws?.readyState === WebSocket.OPEN) ws.send(`{"type":"plan","plan":${json}}`);
  }, 15);
}

/** Find an insert slot anywhere in the console. */
function findSlot(s: ConsoleState, slotId: string): InsertSlot | undefined {
  for (const c of s.channels) for (const i of c.inserts) if (i.id === slotId) return i;
  for (const b of s.buses) for (const i of b.inserts) if (i.id === slotId) return i;
  return s.main.inserts.find((i) => i.id === slotId);
}

function patchSlot(slotId: string, patch: Partial<InsertSlot>) {
  const fix = (list: InsertSlot[]) => (list.some((i) => i.id === slotId) ? list.map((i) => (i.id === slotId ? { ...i, ...patch } : i)) : list);
  useConsole.getState().update((s) => ({
    channels: s.channels.map((c) => (c.inserts.some((i) => i.id === slotId) ? { ...c, inserts: fix(c.inserts) } : c)),
    buses: s.buses.map((b) => (b.inserts.some((i) => i.id === slotId) ? { ...b, inserts: fix(b.inserts) } : b)),
    main: s.main.inserts.some((i) => i.id === slotId) ? { ...s.main, inserts: fix(s.main.inserts) } : s.main,
  }));
}

const setInsert = (slotId: string, patch: Partial<NativeInsert>) =>
  useNative.setState((st) => ({ inserts: { ...st.inserts, [slotId]: { ...(st.inserts[slotId] ?? { params: [] }), ...patch } } }));

function mapFormat(f: string): PluginFormat {
  return f === 'vst3' ? 'vst3' : f === 'audiounit' || f === 'au' ? 'au' : 'vst3';
}

function onMessage(m: any) {
  switch (m.type) {
    case 'hello':
      useNative.setState({ version: m.version });
      break;
    case 'device':
      useNative.setState({ device: m });
      break;
    case 'plugins':
      setNativePlugins(
        (m.list as any[]).map((p) => ({
          id: p.id,
          name: p.name,
          vendor: p.vendor,
          format: mapFormat(p.format),
          category: String(p.category || 'Effect').split('|').pop() || 'Effect',
          params: [],
        })),
      );
      useNative.setState({ scanning: !!m.scanning, blacklisted: m.blacklisted ?? [], scan: m.scanning ? useNative.getState().scan : undefined });
      break;
    case 'plugins.scan':
      useNative.setState({ scanning: true, scan: { progress: m.progress, file: m.file, format: m.format } });
      break;
    case 'meters': {
      const next = new Map<string, MeterReading>();
      (m.ch as [number, number][]).forEach(([peak, gr], i) => next.set(`ch${i + 1}`, { peak, gr }));
      (m.bus as [number, number][]).forEach(([l, r], i) => next.set(`bus${i + 1}`, { peak: l, peakR: r }));
      next.set('main', { peak: m.main[0], peakR: m.main[1] });
      next.set('monitor', { peak: m.mon[0], peakR: m.mon[1] });
      meters = next;
      const f = (x: number | null) => (x === null || x === undefined ? -Infinity : x);
      loudness = { momentary: f(m.loud[0]), shortTerm: f(m.loud[1]), integrated: f(m.loud[2]), peak: [m.main[0], m.main[1]] };
      if (m.pdc !== useNative.getState().pdc) useNative.setState({ pdc: m.pdc });
      break;
    }
    case 'insert.loading':
      setInsert(m.slotId, { loading: true, error: undefined });
      break;
    case 'insert.ready': {
      setInsert(m.slotId, { loading: false, name: m.name, latency: m.latency, hasEditor: m.hasEditor, params: m.params, error: undefined });
      const slot = findSlot(stateOnly(useConsole.getState()), m.slotId);
      if (slot?.state) sendNative({ type: 'insert.setState', slotId: m.slotId, state: slot.state });
      if (slot && slot.pluginName !== m.name) patchSlot(m.slotId, { pluginName: m.name });
      break;
    }
    case 'insert.params': {
      const cur = useNative.getState().inserts[m.slotId];
      if (!cur) break;
      const byId = new Map((m.params as NativeParam[]).map((p) => [p.id, p]));
      setInsert(m.slotId, { params: cur.params.map((p) => byId.get(p.id) ?? p) });
      break;
    }
    case 'insert.state':
      patchSlot(m.slotId, { state: m.state });
      break;
    case 'insert.error':
      setInsert(m.slotId, { loading: false, error: m.message });
      break;
    case 'insert.editor':
      setInsert(m.slotId, { editorOpen: m.open });
      break;
    case 'error':
      useNative.setState({ error: m.message });
      break;
  }
}

export function connectNative(url = useNative.getState().url): Promise<void> {
  disconnectNative();
  useNative.setState({ status: 'connecting', url, error: undefined, inserts: {} });
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      useNative.setState({ status: 'connected' });
      lastPlanJson = '';
      schedulePlan();
      unsubscribe = useConsole.subscribe(schedulePlan);
      resolve();
    };
    sock.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch (err) {
        console.error('Bad engine message', err);
      }
    };
    sock.onerror = () => {
      useNative.setState({ status: 'error', error: `Can't reach the engine at ${url}. Is Merge Engine running?` });
      reject(new Error('connect failed'));
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      unsubscribe?.();
      unsubscribe = null;
      meters = new Map();
      setNativePlugins([]);
      useNative.setState((st) => ({ status: st.status === 'error' ? 'error' : 'off', inserts: {} }));
    };
  });
}

export function disconnectNative() {
  const sock = ws;
  ws = null;
  unsubscribe?.();
  unsubscribe = null;
  sock?.close();
  meters = new Map();
  if (useNative.getState().status !== 'off') useNative.setState({ status: 'off', inserts: {} });
}
