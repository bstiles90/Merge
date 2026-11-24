// AudioWorklet processors, loaded from a Blob URL so the prototype has no extra
// build config. Native port: these become plain DSP classes in the engine.

const code = /* js */ `
const dbToGain = (db) => Math.pow(10, db / 20);

// ---------------------------------------------------------------- noise gate
class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'threshold', defaultValue: -50, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'range', defaultValue: 40, minValue: 0, maxValue: 100, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 1, minValue: 0.05, maxValue: 200, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 150, minValue: 5, maxValue: 4000, automationRate: 'k-rate' },
    ];
  }
  constructor() { super(); this.env = 0; this.gain = 1; this.frames = 0; }
  process(inputs, outputs, p) {
    const input = inputs[0], output = outputs[0];
    if (!input.length) return true;
    const enabled = p.enabled[0] > 0.5;
    const thr = dbToGain(p.threshold[0]);
    const floor = dbToGain(-p.range[0]);
    const att = Math.exp(-1 / (sampleRate * p.attack[0] / 1000));
    const rel = Math.exp(-1 / (sampleRate * p.release[0] / 1000));
    const envCoef = Math.exp(-1 / (sampleRate * 0.005));
    const n = input[0].length;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < input.length; c++) peak = Math.max(peak, Math.abs(input[c][i]));
      this.env = peak > this.env ? peak : this.env * envCoef + peak * (1 - envCoef);
      const target = !enabled || this.env >= thr ? 1 : floor;
      const coef = target > this.gain ? att : rel;
      this.gain = target + (this.gain - target) * coef;
      for (let c = 0; c < output.length; c++) output[c][i] = (input[c] || input[0])[i] * this.gain;
    }
    if ((this.frames += n) >= 4096) { this.frames = 0; this.port.postMessage(this.gain); }
    return true;
  }
}
registerProcessor('merge-gate', GateProcessor);

// ---------------------------------------------- BS.1770 / EBU R128 loudness
class Biquad {
  constructor(b0, b1, b2, a1, a2) { Object.assign(this, { b0, b1, b2, a1, a2 }); this.z1 = 0; this.z2 = 0; }
  run(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
}
function kWeighting(fs) {
  // Coefficients derived for arbitrary sample rates (as in libebur128 / pyloudnorm).
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const hp = [1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  return () => [new Biquad(...shelf), new Biquad(...hp)];
}
class LoudnessProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.make = kWeighting(sampleRate);
    this.filters = [this.make(), this.make()];
    this.blockLen = Math.round(sampleRate * 0.1);
    this.acc = 0; this.count = 0;
    this.blocks = []; // 100ms mean-square history
    this.gated = []; // 400ms block loudness for integrated
    this.peak = [0, 0];
    this.port.onmessage = (e) => { if (e.data === 'reset') { this.gated = []; this.peak = [0, 0]; } };
  }
  process(inputs) {
    const input = inputs[0];
    if (!input.length) return true;
    const n = input[0].length;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let c = 0; c < 2; c++) {
        const x = (input[c] || input[0])[i];
        const a = Math.abs(x); if (a > this.peak[c]) this.peak[c] = a;
        const f = this.filters[c];
        const y = f[1].run(f[0].run(x));
        sum += y * y;
      }
      this.acc += sum; this.count++;
      if (this.count >= this.blockLen) {
        this.blocks.push(this.acc / this.count);
        if (this.blocks.length > 30) this.blocks.shift();
        this.acc = 0; this.count = 0;
        this.report();
      }
    }
    return true;
  }
  lufs(ms) { return ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity; }
  mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
  report() {
    const b = this.blocks;
    const m = b.length >= 4 ? this.mean(b.slice(-4)) : 0;
    const st = b.length >= 30 ? this.mean(b.slice(-30)) : (b.length ? this.mean(b) : 0);
    if (b.length >= 4) {
      const l = this.lufs(m);
      if (l > -70) this.gated.push(m); // absolute gate
      if (this.gated.length > 36000) this.gated.shift();
    }
    let integrated = -Infinity;
    if (this.gated.length) {
      const rel = this.lufs(this.mean(this.gated)) - 10;
      const kept = this.gated.filter((x) => this.lufs(x) > rel);
      if (kept.length) integrated = this.lufs(this.mean(kept));
    }
    this.port.postMessage({ momentary: this.lufs(m), shortTerm: this.lufs(st), integrated, peak: this.peak.slice() });
    this.peak = [0, 0];
  }
}
registerProcessor('merge-loudness', LoudnessProcessor);

// ------------------------------------------------------------------ recorder
class RecorderProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.channels = (opts.processorOptions && opts.processorOptions.channels) || 1;
    this.recording = false;
    this.buf = [];
    this.len = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.recording = true; this.buf = []; this.len = 0; }
      if (e.data === 'stop') { this.flush(); this.recording = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (!this.len) return;
    const out = [];
    for (let c = 0; c < this.channels; c++) {
      const a = new Float32Array(this.len);
      let o = 0;
      for (const chunk of this.buf) { a.set(chunk[c], o); o += chunk[c].length; }
      out.push(a);
    }
    this.port.postMessage({ chunk: out }, out.map((a) => a.buffer));
    this.buf = []; this.len = 0;
  }
  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0];
    const n = 128;
    const frame = [];
    for (let c = 0; c < this.channels; c++) {
      const src = input[c] || input[0];
      frame.push(src ? new Float32Array(src) : new Float32Array(n));
    }
    this.buf.push(frame);
    this.len += frame[0].length;
    if (this.len >= sampleRate) this.flush();
    return true;
  }
}
registerProcessor('merge-recorder', RecorderProcessor);
`;

let url: string | null = null;
export async function loadWorklets(ctx: AudioContext) {
  if (!url) url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
}
