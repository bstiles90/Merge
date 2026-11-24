// Web MIDI control: user keys from notes/CCs, faders from CCs (with learn).
// Works with any class-compliant controller (X-Touch in MIDI mode, nanoKONTROL,
// Stream Deck + MIDI plugin, etc.).

import { faderPosToDb, faderDbToPos } from '../core/mix';
import { useConsole } from '../core/store';
import type { StripRef } from '../core/types';

type Learn = { kind: 'key'; id: string } | { kind: 'fader'; target: StripRef };
let learning: Learn | null = null;
let access: MIDIAccess | null = null;
const listeners = new Set<() => void>();

export function midiStatus() {
  return {
    available: typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator,
    enabled: !!access,
    inputs: access ? [...access.inputs.values()].map((i) => i.name ?? i.id) : [],
    learning,
  };
}
export function onMidiChange(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
const emit = () => listeners.forEach((l) => l());

export function startLearn(l: Learn | null) {
  learning = l;
  emit();
}

function stripFaderDb(target: StripRef): number {
  const s = useConsole.getState();
  if (target.kind === 'channel') return s.channels.find((c) => c.id === target.id)?.faderDb ?? -Infinity;
  if (target.kind === 'bus') return s.buses.find((c) => c.id === target.id)?.faderDb ?? -Infinity;
  if (target.kind === 'dca') return s.dcas.find((c) => c.id === target.id)?.faderDb ?? -Infinity;
  return s.main.faderDb;
}

export function setStripFader(target: StripRef, db: number) {
  const s = useConsole.getState();
  if (target.kind === 'channel') s.updateChannel(target.id, { faderDb: db });
  else if (target.kind === 'bus') s.updateBus(target.id, { faderDb: db });
  else if (target.kind === 'dca') s.updateDca(target.id, { faderDb: db });
  else s.updateMain({ faderDb: db });
}

function onMessage(e: MIDIMessageEvent) {
  const d = e.data;
  if (!d || d.length < 2) return;
  const status = d[0];
  const type = status & 0xf0;
  const data1 = d[1];
  const data2 = d[2] ?? 0;
  const s = useConsole.getState();

  if (learning) {
    if (learning.kind === 'key' && (type === 0x90 || type === 0xb0) && data2 > 0) {
      s.updateKey(learning.id, { midi: { status: status, data1 } });
      learning = null;
      emit();
    } else if (learning.kind === 'fader' && type === 0xb0) {
      const target = learning.target;
      s.update((st) => ({
        midiFaders: [
          ...st.midiFaders.filter((m) => JSON.stringify(m.target) !== JSON.stringify(target)),
          { target, status, data1 },
        ],
      }));
      learning = null;
      emit();
    }
    return;
  }

  // user keys: note on / CC > 0 press, note off / CC 0 release
  for (const key of s.userKeys) {
    if (!key.midi || key.midi.data1 !== data1) continue;
    const kType = key.midi.status & 0xf0;
    const sameChan = (key.midi.status & 0x0f) === (status & 0x0f);
    if (!sameChan) continue;
    if (kType === 0x90 && (type === 0x90 || type === 0x80)) {
      if (type === 0x90 && data2 > 0) s.pressKey(key.id);
      else s.releaseKey(key.id);
    } else if (kType === 0xb0 && type === 0xb0) {
      if (data2 > 0) s.pressKey(key.id);
      else s.releaseKey(key.id);
    }
  }
  // faders (soft takeover not needed for motorised/absolute controllers)
  if (type === 0xb0) {
    for (const m of s.midiFaders) {
      if (m.status === status && m.data1 === data1) setStripFader(m.target, faderPosToDb(data2 / 127));
    }
  }
}

export async function enableMidi() {
  if (access) return;
  access = await navigator.requestMIDIAccess({ sysex: false });
  const bind = () => {
    access!.inputs.forEach((inp) => (inp.onmidimessage = onMessage));
    emit();
  };
  access.onstatechange = bind;
  bind();
  // feedback: send fader positions back to motorised controllers / LED rings
  let last = '';
  useConsole.subscribe((s) => {
    if (!access) return;
    const msgs = s.midiFaders.map((m) => [m.status, m.data1, Math.round(faderDbToPos(stripFaderDb(m.target)) * 127)]);
    const key = JSON.stringify(msgs);
    if (key === last) return;
    last = key;
    access.outputs.forEach((o) => msgs.forEach((msg) => o.send(msg)));
  });
}
