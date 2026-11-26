// Native virtual soundcheck: recorded takes and imported multitracks as timeline clips.
// The audio stays in files on disk (the engine plays them); clips just point at them.

import { newId } from './defaults';
import type { Clip, ConsoleState } from './types';

export interface AudioFileInfo {
  file: string;
  name: string;
  duration: number;
  channels: number;
}

/** "01 Kick In.wav", "Kick_In", "Ch 1 - Kick In" → "kick in" */
export function trackKey(name: string): string {
  return name
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/^\s*(ch(annel)?\s*)?\d+\s*[-_.:)]?\s*/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Put a multitrack's files on channels: a file goes to the channel with the same name
 * ("Kick In.wav" → Kick In), the rest to channels that have no clips yet, in order.
 * All files start together at `start` so the tracks stay in sync.
 */
export function assignMultitrack(s: Pick<ConsoleState, 'channels' | 'clips'>, files: AudioFileInfo[], start = 0): { clips: Clip[]; unassigned: AudioFileInfo[] } {
  const taken = new Set<string>();
  const byName = new Map(s.channels.map((c) => [trackKey(c.name), c.id]));
  const clipFor = (f: AudioFileInfo, trackId: string): Clip => ({
    id: newId('clip'),
    trackId,
    name: f.name,
    start,
    offset: 0,
    duration: f.duration,
    bufferId: f.file,
    channels: f.channels,
    file: f.file,
  });
  const clips: Clip[] = [];
  const rest: AudioFileInfo[] = [];
  for (const f of files) {
    const id = byName.get(trackKey(f.name));
    if (id && !taken.has(id)) {
      taken.add(id);
      clips.push(clipFor(f, id));
    } else rest.push(f);
  }
  const free = s.channels.filter((c) => !taken.has(c.id) && !s.clips.some((x) => x.trackId === c.id));
  const unassigned: AudioFileInfo[] = [];
  for (const f of rest) {
    const c = free.shift();
    if (!c) unassigned.push(f);
    else {
      taken.add(c.id);
      clips.push(clipFor(f, c.id));
    }
  }
  return { clips, unassigned };
}

/** Clips from a finished native recording (one per armed channel, plus PGM). */
export function takesToClips(s: Pick<ConsoleState, 'channels' | 'clips'>, takes: { trackId: string; file: string; channels: number; start: number; duration: number }[]): Clip[] {
  return takes.map((t) => {
    const name = t.trackId === 'pgm' ? 'PGM' : s.channels.find((c) => c.id === t.trackId)?.name ?? t.trackId;
    const n = s.clips.filter((c) => c.trackId === t.trackId).length + 1;
    return { id: newId('clip'), trackId: t.trackId, name: `${name} #${n}`, start: t.start, offset: 0, duration: t.duration, bufferId: t.file, channels: t.channels, file: t.file };
  });
}

/** The clips the engine should play on a channel (only native, file-backed ones). */
export const playbackClips = (s: Pick<ConsoleState, 'clips'>, channelId: string) =>
  s.clips.filter((c) => c.trackId === channelId && c.file).map((c) => ({ file: c.file!, start: c.start, offset: c.offset, duration: c.duration }));
