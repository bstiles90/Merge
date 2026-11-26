import type { Bus, Channel, ConsoleState, InsertSlot, MixSnapshot, SafePart, SafeSet, Scene } from './types';

export function takeSnapshot(s: ConsoleState): MixSnapshot {
  return structuredClone({
    channels: s.channels,
    buses: s.buses,
    main: s.main,
    dcas: s.dcas,
    muteGroups: s.muteGroups,
  });
}

/** The parts a strip's recall safe can protect, with what each covers. */
export const SAFE_PARTS: { id: SafePart; label: string; about: string }[] = [
  { id: 'input', label: 'Input', about: 'Gain, polarity, delay' },
  { id: 'fader', label: 'Fader', about: 'Fader level' },
  { id: 'mute', label: 'Mute', about: 'Mute on / off' },
  { id: 'pan', label: 'Pan', about: 'Pan / balance' },
  { id: 'sends', label: 'Sends', about: 'Send levels, on / off and tap points' },
  { id: 'routing', label: 'Routing', about: 'Main LR and bus assignments (bus: its output)' },
  { id: 'groups', label: 'Groups', about: 'DCA and mute-group membership' },
  { id: 'inserts', label: 'Plugins', about: 'The whole plugin rack and its settings (single slots: the lock on each plugin)' },
  { id: 'name', label: 'Name', about: 'Name and colour' },
];

export const isSafe = (strip: { recallSafe: boolean; safe?: SafeSet }, part: SafePart) => strip.recallSafe || !!strip.safe?.[part];

/** Scene rack with the current rack's safed slots kept (in their place, with their settings). */
function mergeInserts(cur: InsertSlot[], saved: InsertSlot[]): InsertSlot[] {
  // a plugin switched off (e.g. it crashed Merge) stays off through scene recalls
  const off = new Set(cur.filter((i) => i.offline).map((i) => i.id));
  if (off.size) saved = saved.map((i) => (off.has(i.id) ? { ...i, offline: true } : i));
  const keep = cur.filter((i) => i.recallSafe);
  if (!keep.length) return saved;
  const out = saved.filter((i) => !keep.some((k) => k.id === i.id));
  for (const k of keep) out.splice(Math.min(cur.indexOf(k), out.length), 0, k);
  return out.slice(0, 8);
}

function recallChannel(cur: Channel, saved: Channel): Channel {
  if (cur.recallSafe) return cur;
  const safe = (p: SafePart) => isSafe(cur, p);
  return {
    ...cur,
    ...(safe('input') ? {} : { gainDb: saved.gainDb, phaseInvert: saved.phaseInvert, delayMs: saved.delayMs }),
    ...(safe('fader') ? {} : { faderDb: saved.faderDb }),
    ...(safe('mute') ? {} : { mute: saved.mute }),
    ...(safe('pan') ? {} : { pan: saved.pan }),
    ...(safe('sends') ? {} : { sends: saved.sends }),
    ...(safe('routing') ? {} : { mainAssign: saved.mainAssign, routes: saved.routes }),
    ...(safe('groups') ? {} : { dcas: saved.dcas, muteGroups: saved.muteGroups }),
    ...(safe('inserts') ? {} : { inserts: mergeInserts(cur.inserts, saved.inserts) }),
    ...(safe('name') ? {} : { name: saved.name, color: saved.color }),
    // never recalled: input source, mono/stereo, solo, record arm, playback mode, the safes themselves
  };
}

function recallBus(cur: Bus, saved: Bus): Bus {
  if (cur.recallSafe) return cur;
  const safe = (p: SafePart) => isSafe(cur, p);
  return {
    ...cur,
    ...(safe('input') ? {} : { delayMs: saved.delayMs }),
    ...(safe('fader') ? {} : { faderDb: saved.faderDb }),
    ...(safe('mute') ? {} : { mute: saved.mute }),
    ...(safe('sends') ? {} : { sends: saved.sends }),
    ...(safe('routing') ? {} : { output: saved.output }),
    ...(safe('groups') ? {} : { muteGroups: saved.muteGroups }),
    ...(safe('inserts') ? {} : { inserts: mergeInserts(cur.inserts, saved.inserts) }),
    ...(safe('name') ? {} : { name: saved.name, color: saved.color }),
    // never recalled: whether the bus exists, its type, solo, the safes
  };
}

/**
 * Recall a scene, honouring the global recall scope and per-strip recall safes (whole strip,
 * parts of it, or single plugin slots). Live-session things (input source, solo, record arm,
 * playback mode) are never recalled.
 */
export function applyScene(s: ConsoleState, scene: Scene): ConsoleState {
  const snap = structuredClone(scene.snapshot);
  const scope = s.sceneScope;
  const next: ConsoleState = { ...s, currentScene: scene.id };

  if (scope.channels) {
    next.channels = s.channels.map((cur) => {
      const saved = snap.channels.find((c) => c.id === cur.id);
      return saved ? recallChannel(cur, saved) : cur;
    });
  }
  if (scope.buses) {
    next.buses = s.buses.map((cur) => {
      const saved = snap.buses.find((b) => b.id === cur.id);
      return saved ? recallBus(cur, saved) : cur;
    });
  }
  // scenes stored before newer main fields existed keep the current values
  if (scope.main) next.main = { ...s.main, ...snap.main, inserts: mergeInserts(s.main.inserts, snap.main.inserts ?? s.main.inserts) };
  if (scope.dcas) next.dcas = snap.dcas;
  if (scope.muteGroups) next.muteGroups = snap.muteGroups;
  return next;
}
