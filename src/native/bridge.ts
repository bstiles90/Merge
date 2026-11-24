// Link between the console UI and the native Merge Engine (engine/), over a
// localhost WebSocket. The UI stays the source of truth: it compiles the console
// state into a mix plan and streams it; the engine streams back meters, loudness,
// device info and plugin state. Protocol: engine/PROTOCOL.md.

import { create } from 'zustand';
import { buildMixPlan } from '../core/plan';
import { setNativePlugins, type PluginFormat } from '../core/plugins';
import { parseShow, serializeShow, stateOnly, useConsole } from '../core/store';
import { EMBEDDED, EMBEDDED_URL } from './embedded';
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
  /** show file on disk (embedded app) */
  showPath?: string;
  /** short status line, e.g. "Saved" */
  notice?: string;
  /** plugin GUI currently docked in the Merge window */
  docked?: { slotId: string; name: string; width: number; height: number } | null;
  /** the engine can't dock plugin GUIs (e.g. Linux): show parameters instead */
  dockUnavailable?: boolean;
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

/** Program true peak (dBTP): latest and max hold since reset. */
let truePeak = { tpDb: -Infinity, tpMaxDb: -Infinity };
export const readNativeTruePeak = () => truePeak;
export function resetNativeTruePeakHold() {
  truePeak = { ...truePeak, tpMaxDb: -Infinity };
}

export function sendNative(msg: object) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Inside the app: write a line to the engine's log (console errors and start-up steps). */
export function uiLog(text: string) {
  if (EMBEDDED) sendNative({ type: 'ui.log', text: text.slice(0, 500) });
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
      if (m.tp) {
        const tpDb = 20 * Math.log10(Math.max(m.tp[0], m.tp[1], 1e-9));
        truePeak = { tpDb, tpMaxDb: Math.max(truePeak.tpMaxDb, tpDb) };
      }
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
    case 'show.autosave':
      // embedded app start-up: reopen the last show, then begin autosaving
      if (!autosaveReady) {
        if (m.text) {
          try {
            useConsole.getState().loadShow(parseShow(m.text));
            uiLog(`restored show "${useConsole.getState().showName}"`);
          } catch (err) {
            console.error('Could not restore the last show', err);
            uiLog(`could not restore the last show: ${err}`);
          }
        }
        autosaveReady = true;
      }
      break;
    case 'insert.docked':
      if (m.error) uiLog(`dock unavailable: ${m.error}`);
      useNative.setState({ docked: m.slotId ? { slotId: m.slotId, name: m.name, width: m.width, height: m.height } : null, ...(m.error ? { dockUnavailable: true } : {}) });
      break;
    case 'show.saved':
      useNative.setState({ showPath: m.ok ? m.path : useNative.getState().showPath, notice: m.ok ? `Saved ${String(m.path).split(/[\\/]/).pop()}` : 'Save failed' });
      break;
    case 'show.opened':
      try {
        useConsole.getState().loadShow(parseShow(m.text));
        useNative.setState({ showPath: m.path, notice: `Opened ${String(m.path).split(/[\\/]/).pop()}` });
      } catch (err) {
        useNative.setState({ notice: `Could not open show: ${err}` });
      }
      break;
    case 'error':
      useNative.setState({ error: m.message });
      break;
  }
}

// ---- docked plugin GUI (embedded app) --------------------------------------
export function dockInsert(slotId: string) {
  if (useNative.getState().docked?.slotId !== slotId) sendNative({ type: 'insert.dock', slotId });
}
export function undockInsert() {
  if (useNative.getState().docked) sendNative({ type: 'insert.undock' });
}
let lastBounds = '';
/** Where the console's plugin area is (window coordinates); the engine places the GUI there. */
export function sendDockBounds(r: { x: number; y: number; w: number; h: number } | null) {
  const msg = r ? { type: 'dock.bounds', x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), visible: true } : { type: 'dock.bounds', x: 0, y: 0, w: 0, h: 0, visible: false };
  const key = JSON.stringify(msg);
  if (key === lastBounds) return;
  lastBounds = key;
  sendNative(msg);
}

// ---- show persistence in the embedded app --------------------------------
let autosaveReady = false;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAutosave() {
  if (!EMBEDDED || !autosaveReady) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => sendNative({ type: 'show.autosave', text: serializeShow(stateOnly(useConsole.getState())) }), 1000);
}

/** Inside the Merge app: connect to our own engine, retrying until it answers. */
export function startEmbedded() {
  if (!EMBEDDED) return;
  useNative.setState({ url: EMBEDDED_URL });
  window.addEventListener('error', (e) => uiLog(`error: ${e.message} (${e.filename}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => uiLog(`unhandled: ${e.reason}`));
  const attempt = () => {
    if (useNative.getState().status === 'connected') return;
    connectNative(EMBEDDED_URL).catch(() => setTimeout(attempt, 1000));
  };
  attempt();
  useConsole.subscribe(scheduleAutosave);
  // reconnect if the link ever drops
  useNative.subscribe((st, prev) => {
    if (prev.status === 'connected' && st.status !== 'connected') setTimeout(attempt, 1000);
  });
}

export function connectNative(url = useNative.getState().url): Promise<void> {
  disconnectNative();
  useNative.setState({ status: 'connecting', url, error: undefined, inserts: {} });
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      useNative.setState({ status: 'connected' });
      if (EMBEDDED && !autosaveReady) sendNative({ type: 'show.loadAutosave' });
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
