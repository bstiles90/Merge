import type { StripRef } from './types';

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
