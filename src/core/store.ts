import { withCreatedBuses } from './buses';
import { startSceneFade, stopSceneFade } from './sceneFade';
import { runMacro, stopMacro } from './macros';
import { services } from './services';
import { create, type StateCreator } from 'zustand';
import { syncLinks } from './links';
import { runActions } from './actions';
import { defaultState } from './defaults';
import type { ActionCall, Bus, Channel, ConsoleState, Dca, Main, MuteGroup, StripRef, UserKey } from './types';

export interface ConsoleStore extends ConsoleState {
  dispatch: (calls: ActionCall | ActionCall[]) => void;
  update: (fn: (s: ConsoleState) => Partial<ConsoleState>) => void;
  updateChannel: (id: string, patch: Partial<Channel> | ((c: Channel) => Partial<Channel>)) => void;
  updateBus: (id: string, patch: Partial<Bus> | ((b: Bus) => Partial<Bus>)) => void;
  updateDca: (id: string, patch: Partial<Dca>) => void;
  updateMuteGroup: (id: string, patch: Partial<MuteGroup>) => void;
  updateMain: (patch: Partial<Main>) => void;
  updateKey: (id: string, patch: Partial<UserKey>) => void;
  select: (ref: StripRef | null) => void;
  pressKey: (id: string) => void;
  releaseKey: (id: string) => void;
  loadShow: (s: ConsoleState) => void;
}

const resolve = <T,>(cur: T, patch: Partial<T> | ((c: T) => Partial<T>)) =>
  ({ ...cur, ...(typeof patch === 'function' ? (patch as (c: T) => Partial<T>)(cur) : patch) }) as T;

export function stateOnly(s: ConsoleStore | ConsoleState): ConsoleState {
  const d = defaultState();
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(d)) out[k] = (s as any)[k];
  return out as unknown as ConsoleState;
}

/** Mirror stereo-linked channel settings after every state change, whatever made it. */
const withStereoLinks =
  (config: StateCreator<ConsoleStore>): StateCreator<ConsoleStore> =>
  (set, get, api) =>
    config(
      (partial, replace) => {
        const prev = get();
        (set as (p: typeof partial, r?: boolean) => void)(partial, replace as boolean | undefined);
        const next = get();
        if (next.channels !== prev?.channels && next.stereoLinks?.length) {
          const channels = syncLinks(prev, next);
          if (channels !== next.channels) set({ channels });
        }
      },
      get,
      api,
    );

export const useConsole = create<ConsoleStore>()(withStereoLinks((set, get) => ({
  ...loadAutosave(),
  dispatch: (calls) => {
    const list = Array.isArray(calls) ? calls : [calls];
    const prev = stateOnly(get());
    const next = runActions(prev, list);
    // a scene recall with a fade time glides instead of jumping
    const recalled = list.some((c) => c.type === 'scene.recall' || c.type === 'scene.next' || c.type === 'scene.prev');
    const scene = recalled ? next.scenes.find((x) => x.id === next.currentScene) : undefined;
    if (scene?.fadeMs && scene.fadeMs > 0 && (next.currentScene !== prev.currentScene || list.some((c) => c.type === 'scene.recall'))) {
      startSceneFade(prev, next, scene.fadeMs, () => stateOnly(get()), (p) => set(p));
      return;
    }
    if (recalled) stopSceneFade();
    set(next);
  },
  update: (fn) => set(fn(stateOnly(get()))),
  updateChannel: (id, patch) =>
    set((s) => ({ channels: s.channels.map((c) => (c.id === id ? resolve(c, patch) : c)) })),
  updateBus: (id, patch) => set((s) => ({ buses: s.buses.map((b) => (b.id === id ? resolve(b, patch) : b)) })),
  updateDca: (id, patch) => set((s) => ({ dcas: s.dcas.map((d) => (d.id === id ? { ...d, ...patch } : d)) })),
  updateMuteGroup: (id, patch) =>
    set((s) => ({ muteGroups: s.muteGroups.map((g) => (g.id === id ? { ...g, ...patch } : g)) })),
  updateMain: (patch) => set((s) => ({ main: { ...s.main, ...patch } })),
  updateKey: (id, patch) => set((s) => ({ userKeys: s.userKeys.map((k) => (k.id === id ? { ...k, ...patch } : k)) })),
  select: (ref) => set({ selected: ref }),
  pressKey: (id) => {
    const s = get();
    const key = s.userKeys.find((k) => k.id === id);
    if (!key || s.keyStates[id]) return; // ignore auto-repeat while held
    const next = runActions(stateOnly(s), key.actions);
    set({ ...next, keyStates: { ...s.keyStates, [id]: true } });
  },
  releaseKey: (id) => {
    const s = get();
    const key = s.userKeys.find((k) => k.id === id);
    if (!key || !s.keyStates[id]) return;
    // Momentary keys fire their actions again on release (toggle back).
    const next = key.mode === 'momentary' ? runActions(stateOnly(s), key.actions) : stateOnly(s);
    set({ ...next, keyStates: { ...s.keyStates, [id]: false } });
  },
  loadShow: (show) => set({ ...defaultState(), ...show, keyStates: {} }),
})));

// ---- show files ------------------------------------------------------------
// JSON has no Infinity; encode -Infinity faders as the string "-inf".
export function serializeShow(s: ConsoleState): string {
  const { keyStates: _k, macrosRunning: _m, ...rest } = s;
  return JSON.stringify(
    { format: 'merge-show', version: 1, show: { ...rest, transport: { ...s.transport, playing: false, recording: false } } },
    (_key, v) => (v === -Infinity ? '-inf' : v),
    1,
  );
}

export function parseShow(text: string): ConsoleState {
  const obj = JSON.parse(text, (_key, v) => (v === '-inf' ? -Infinity : v));
  if (obj?.format !== 'merge-show') throw new Error('Not a Merge show file');
  const d = defaultState();
  // fill in fields added since the show was saved
  const show = obj.show;
  // shows from before 64 buses: keep their buses (feeds, so they don't suddenly join Main LR), add the rest
  const saved: any[] = Array.isArray(show.buses) ? show.buses : [];
  const buses = d.buses.map((def) => {
    const b = saved.find((x) => x?.id === def.id);
    // `created` comes only from the saved show (older shows have none: worked out below)
    return b ? { ...def, ...b, output: b.output ?? 'none', created: b.created } : { ...def, created: saved.length ? false : def.created };
  });
  const channels = Array.isArray(show.channels) ? show.channels.map((c: any) => ({ ...c, routes: c.routes ?? [] })) : d.channels;
  return withCreatedBuses({ ...d, ...show, buses, channels, main: { ...d.main, ...show.main }, keyStates: {} });
}

const AUTOSAVE_KEY = 'merge.autosave.v1';

function loadAutosave(): ConsoleState {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    if (text) return parseShow(text);
  } catch {
    /* ignore */
  }
  return defaultState();
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
if (typeof window !== 'undefined') {
  useConsole.subscribe((s) => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, serializeShow(stateOnly(s)));
      } catch {
        /* storage unavailable */
      }
    }, 800);
  });
}

// macros run against the live store
const macroHost = { get: () => stateOnly(useConsole.getState()), set: (p: Partial<ConsoleState>) => useConsole.getState().update(() => p) };
services.runMacro = (id) => {
  const m = useConsole.getState().macros?.find((x) => x.id === id);
  if (m) void runMacro(macroHost, m);
};
services.stopMacro = (id) => stopMacro(macroHost, id);
