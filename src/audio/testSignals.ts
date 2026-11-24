// Generated test material so the console makes sound without any files or inputs.

const cache = new Map<string, AudioBuffer>();

function rand(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

export function pinkNoise(ctx: BaseAudioContext): AudioBuffer {
  const key = `pink@${ctx.sampleRate}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const len = ctx.sampleRate * 6;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const r = rand(7);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = r();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.08;
    b6 = w * 0.115926;
  }
  cache.set(key, buf);
  return buf;
}

/**
 * A crude "talker": glottal pulse train through two formant resonators, with
 * syllable and phrase envelopes and pauses. Good enough to exercise gates,
 * compressors, mix-minus and loudness metering.
 */
export function speech(ctx: BaseAudioContext, voice: number): AudioBuffer {
  const key = `speech${voice}@${ctx.sampleRate}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const sr = ctx.sampleRate;
  const len = sr * 14;
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const r = rand(voice * 31 + 3);
  const basePitch = 90 + ((voice / 100) % 12) * 10; // voice param picks a pitch
  let phase = 0;
  // two resonators (formants)
  const res = (f: number, bw: number) => {
    const rr = Math.exp((-Math.PI * bw) / sr);
    return { a1: -2 * rr * Math.cos((2 * Math.PI * f) / sr), a2: rr * rr, y1: 0, y2: 0 };
  };
  let f1 = res(500, 80), f2 = res(1500, 120);
  let syllEnd = 0, env = 0, target = 0, pauseUntil = 0;
  const formants = [[730, 1090], [270, 2290], [530, 1840], [570, 840], [300, 870], [660, 1720]];
  for (let i = 0; i < len; i++) {
    if (i >= syllEnd) {
      const dur = sr * (0.12 + Math.abs(r()) * 0.18);
      syllEnd = i + dur;
      if (Math.abs(r()) < 0.12) pauseUntil = i + sr * (0.3 + Math.abs(r()) * 0.6);
      const [a, b] = formants[Math.floor(Math.abs(r()) * formants.length) % formants.length];
      f1 = { ...res(a, 80), y1: f1.y1, y2: f1.y2 };
      f2 = { ...res(b, 120), y1: f2.y1, y2: f2.y2 };
    }
    target = i < pauseUntil ? 0 : Math.sin((Math.PI * (syllEnd - i)) / (sr * 0.25)) > 0 ? 1 : 0.3;
    env += (target - env) * 0.002;
    const pitch = basePitch * (1 + 0.08 * Math.sin((2 * Math.PI * i) / (sr * 1.7)));
    phase += pitch / sr;
    let src = 0;
    if (phase >= 1) {
      phase -= 1;
      src = 1;
    }
    src += r() * 0.04; // breath
    const y1 = src - f1.a1 * f1.y1 - f1.a2 * f1.y2;
    f1.y2 = f1.y1;
    f1.y1 = y1;
    const y2 = src - f2.a1 * f2.y1 - f2.a2 * f2.y2;
    f2.y2 = f2.y1;
    f2.y1 = y2;
    d[i] = (y1 * 0.02 + y2 * 0.012) * env;
  }
  // normalise to about -12 dBFS peak
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
  const g = peak > 0 ? 0.25 / peak : 1;
  for (let i = 0; i < len; i++) d[i] *= g;
  cache.set(key, buf);
  return buf;
}
