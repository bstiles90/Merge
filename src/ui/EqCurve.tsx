import { useEffect, useRef } from 'react';
import type { Channel } from '../core/types';

// Draws the EQ + HPF response using an OfflineAudioContext's biquads so it
// matches exactly what the engine applies.
const offline = typeof OfflineAudioContext !== 'undefined' ? new OfflineAudioContext(1, 128, 48000) : null;
const N = 200;
const freqs = new Float32Array(N).map((_, i) => 20 * Math.pow(1000, i / (N - 1)));

export function EqCurve({ eq, hpf }: { eq: Channel['eq']; hpf: Channel['hpf'] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !offline) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = 70;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const g = cv.getContext('2d')!;
    g.scale(dpr, dpr);
    g.fillStyle = '#0d0f12';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#1f242a';
    for (const f of [100, 1000, 10000]) {
      const x = (Math.log(f / 20) / Math.log(1000)) * w;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(0, h / 2);
    g.lineTo(w, h / 2);
    g.stroke();
    const total = new Float32Array(N);
    const mag = new Float32Array(N);
    const ph = new Float32Array(N);
    const filters: BiquadFilterNode[] = [];
    if (hpf.on) {
      const f = offline.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = hpf.freq;
      f.Q.value = 0.707;
      filters.push(f);
    }
    if (eq.on)
      for (const b of eq.bands) {
        const f = offline.createBiquadFilter();
        f.type = b.type;
        f.frequency.value = b.freq;
        f.gain.value = b.gainDb;
        f.Q.value = b.q;
        filters.push(f);
      }
    for (const f of filters) {
      f.getFrequencyResponse(freqs, mag, ph);
      for (let i = 0; i < N; i++) total[i] += 20 * Math.log10(Math.max(1e-6, mag[i]));
    }
    g.strokeStyle = eq.on ? '#ffc53d' : '#666';
    g.lineWidth = 1.5;
    g.beginPath();
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * w;
      const y = h / 2 - (Math.max(-18, Math.min(18, total[i])) / 18) * (h / 2 - 2);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }, [eq, hpf]);
  return <canvas ref={ref} className="eq-curve" />;
}
