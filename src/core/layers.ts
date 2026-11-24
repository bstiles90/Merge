import type { ConsoleState, StripRef } from './types';

/**
 * Move a strip from one fader slot to another on a page. Dropping on an empty slot
 * simply moves it there; dropping on an occupied slot inserts it and shifts the
 * strips in between along (like dragging tracks in a DAW). Page length is fixed.
 */
export function moveSlot(slots: (StripRef | null)[], from: number, to: number): (StripRef | null)[] {
  if (from === to || from < 0 || to < 0 || from >= slots.length || to >= slots.length) return slots;
  const out = slots.slice();
  if (out[to] === null) {
    out[to] = out[from];
    out[from] = null;
    return out;
  }
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

const same = (a: StripRef | null, b: StripRef | null) => JSON.stringify(a) === JSON.stringify(b);

/** Put a strip in the first empty slot of a page (no-op if already there or full). */
export function addToPage(slots: (StripRef | null)[], ref: StripRef): (StripRef | null)[] {
  if (slots.some((s) => same(s, ref))) return slots;
  const i = slots.indexOf(null);
  if (i < 0) return slots;
  const out = slots.slice();
  out[i] = ref;
  return out;
}

/** Page in the bank that page keys currently act on. */
export function focusedLayerId(s: Pick<ConsoleState, 'bankLayout' | 'focusBank' | 'currentLayer' | 'currentLayerB'>): string {
  return s.bankLayout === 'split' && s.focusBank === 'B' ? s.currentLayerB : s.currentLayer;
}

export function setFocusedLayer(s: ConsoleState, id: string): ConsoleState {
  return s.bankLayout === 'split' && s.focusBank === 'B' ? { ...s, currentLayerB: id } : { ...s, currentLayer: id };
}

/** Remove a page, moving either bank off it if it was showing. */
export function deletePage(s: ConsoleState, id: string): Partial<ConsoleState> {
  const idx = s.layers.findIndex((l) => l.id === id);
  const layers = s.layers.filter((l) => l.id !== id);
  if (!layers.length) return {};
  const fallback = layers[Math.max(0, idx - 1)].id;
  return {
    layers,
    currentLayer: s.currentLayer === id ? fallback : s.currentLayer,
    currentLayerB: s.currentLayerB === id ? fallback : s.currentLayerB,
  };
}
