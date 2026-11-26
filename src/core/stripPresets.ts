// Channel strip presets: the whole rack (plugins with their settings) plus gain, polarity,
// delay and pan. Not routing, sends, groups or the channel's name: a preset is "how this
// source is processed", reusable on any channel and in any show.

import { create } from 'zustand';
import { newId } from './defaults';
import type { Channel, InsertSlot } from './types';

export interface StripPreset {
  id: string;
  name: string;
  saved: string; // ISO date
  inserts: InsertSlot[];
  gainDb: number;
  phaseInvert: boolean;
  delayMs: number;
  pan: number;
  stereo?: boolean;
}

export function makePreset(ch: Channel, name: string): StripPreset {
  return {
    id: newId('sp'),
    name: name.trim() || ch.name,
    saved: new Date().toISOString(),
    inserts: structuredClone(ch.inserts).map(({ recallSafe: _r, ...i }) => i),
    gainDb: ch.gainDb,
    phaseInvert: ch.phaseInvert,
    delayMs: ch.delayMs,
    pan: ch.pan,
    ...(ch.stereo ? { stereo: true } : {}),
  };
}

/** The channel with the preset applied (fresh slot ids, so plugins load as new instances). */
export function applyPreset(ch: Channel, p: StripPreset): Partial<Channel> {
  return {
    inserts: p.inserts.map((i) => ({ ...structuredClone(i), id: newId('ins') })),
    gainDb: p.gainDb,
    phaseInvert: p.phaseInvert,
    delayMs: p.delayMs,
    pan: p.pan,
    ...(p.stereo !== undefined && !!p.stereo !== !!ch.stereo ? { stereo: p.stereo } : {}),
  };
}

export function parsePresets(text: string | null | undefined): StripPreset[] {
  try {
    const v = JSON.parse(text ?? '[]');
    return Array.isArray(v?.presets) ? v.presets : Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
export const serializePresets = (list: StripPreset[]) => JSON.stringify({ format: 'merge-strip-presets', version: 1, presets: list });

/** The preset library. Where it's kept (engine file or browser storage) is set by `persist`. */
export const usePresets = create<{ list: StripPreset[]; loaded: boolean }>(() => ({ list: [], loaded: false }));
let persist: (text: string) => void = (text) => {
  try {
    localStorage.setItem('merge.stripPresets', text);
  } catch {
    /* storage unavailable */
  }
};
export function setPresetStorage(save: (text: string) => void) {
  persist = save;
}
export function loadPresets(text: string | null | undefined) {
  usePresets.setState({ list: parsePresets(text), loaded: true });
}
export function savePresetList(list: StripPreset[]) {
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
  usePresets.setState({ list: sorted, loaded: true });
  persist(serializePresets(sorted));
}
export function addPreset(p: StripPreset) {
  // same name replaces (re-saving a preset updates it)
  savePresetList([...usePresets.getState().list.filter((x) => x.name.toLowerCase() !== p.name.toLowerCase()), p]);
}
export function deletePreset(id: string) {
  savePresetList(usePresets.getState().list.filter((x) => x.id !== id));
}

// browser: load from local storage straight away (the app loads from the engine on connect)
try {
  if (typeof localStorage !== 'undefined') loadPresets(localStorage.getItem('merge.stripPresets'));
} catch {
  /* storage unavailable */
}
