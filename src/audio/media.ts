// Recorded audio lives here (not in the console state) – large buffers, keyed by id.

export interface MediaBuffer {
  id: string;
  sampleRate: number;
  data: Float32Array[]; // one per channel
  /** waveform overview: max abs per bucket, first channel mixed */
  peaks: Float32Array;
  peaksPerSecond: number;
}

const buffers = new Map<string, MediaBuffer>();
const audioBufferCache = new Map<string, AudioBuffer>();
const listeners = new Set<() => void>();

export const PEAKS_PER_SECOND = 100;

export function addMedia(id: string, sampleRate: number, data: Float32Array[]) {
  const bucket = Math.max(1, Math.floor(sampleRate / PEAKS_PER_SECOND));
  const len = data[0]?.length ?? 0;
  const peaks = new Float32Array(Math.ceil(len / bucket));
  for (let i = 0; i < peaks.length; i++) {
    let m = 0;
    const end = Math.min(len, (i + 1) * bucket);
    for (const ch of data) for (let j = i * bucket; j < end; j++) m = Math.max(m, Math.abs(ch[j]));
    peaks[i] = m;
  }
  buffers.set(id, { id, sampleRate, data, peaks, peaksPerSecond: sampleRate / bucket });
  listeners.forEach((l) => l());
}

/** A waveform overview only (native recordings and imports: the audio stays on disk). */
export function addPeaks(id: string, peaks: Float32Array, peaksPerSecond: number) {
  buffers.set(id, { id, sampleRate: 0, data: [], peaks, peaksPerSecond });
  listeners.forEach((l) => l());
}

export function getMedia(id: string) {
  return buffers.get(id);
}

export function onMediaChange(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getAudioBuffer(ctx: BaseAudioContext, id: string): AudioBuffer | null {
  const cached = audioBufferCache.get(id);
  if (cached) return cached;
  const m = buffers.get(id);
  if (!m || !m.data[0]?.length) return null;
  const buf = ctx.createBuffer(m.data.length, m.data[0].length, m.sampleRate);
  m.data.forEach((d, i) => buf.copyToChannel(d as Float32Array<ArrayBuffer>, i));
  audioBufferCache.set(id, buf);
  return buf;
}

/** 24-bit PCM WAV of a section of a media buffer. */
export function encodeWav(m: MediaBuffer, offsetSec = 0, durationSec?: number): Blob {
  const start = Math.floor(offsetSec * m.sampleRate);
  const end = durationSec === undefined ? m.data[0].length : Math.min(m.data[0].length, start + Math.floor(durationSec * m.sampleRate));
  const frames = Math.max(0, end - start);
  const ch = m.data.length;
  const bps = 3;
  const dataLen = frames * ch * bps;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, m.sampleRate, true);
  v.setUint32(28, m.sampleRate * ch * bps, true);
  v.setUint16(32, ch * bps, true);
  v.setUint16(34, 24, true);
  str(36, 'data');
  v.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = start; i < end; i++) {
    for (let c = 0; c < ch; c++) {
      const x = Math.max(-1, Math.min(1, m.data[c][i]));
      const s = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff);
      v.setUint8(o, s & 0xff);
      v.setUint8(o + 1, (s >> 8) & 0xff);
      v.setUint8(o + 2, (s >> 16) & 0xff);
      o += 3;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Decode a dropped/imported audio file into the media store. */
export async function importAudioFile(ctx: BaseAudioContext, file: File, id: string): Promise<MediaBuffer> {
  const ab = await file.arrayBuffer();
  const audio = await ctx.decodeAudioData(ab);
  const data = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i).slice());
  addMedia(id, audio.sampleRate, data);
  audioBufferCache.set(id, audio);
  return buffers.get(id)!;
}
