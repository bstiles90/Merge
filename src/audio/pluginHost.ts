// Plugin host. In the browser prototype it instantiates built-in Web Audio
// processors. The interface (create from descriptor id, set params, bypass,
// dispose, report latency) is what a native VST3/AU/SoundGrid host implements.

import { getPlugin } from '../core/plugins';
import { dbToGain } from '../core/mix';

export interface PluginInstance {
  readonly pluginId: string;
  readonly input: AudioNode;
  readonly output: AudioNode;
  setParams(p: Record<string, number>): void;
  setBypass(b: boolean): void;
  dispose(): void;
}

const T = 0.02;

abstract class Base implements PluginInstance {
  input: GainNode;
  output: GainNode;
  protected dry: GainNode;
  protected wet: GainNode;
  protected mix = 1;
  protected bypass = false;
  protected params: Record<string, number> = {};
  constructor(public readonly pluginId: string, protected ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.input.connect(this.dry).connect(this.output);
    this.wet.connect(this.output);
  }
  /** true for effects with a mix knob (parallel); false for inline processors */
  protected parallel = false;
  protected applyMix() {
    const t = this.ctx.currentTime;
    const wet = this.bypass ? 0 : this.parallel ? this.mix : 1;
    const dry = this.bypass ? 1 : this.parallel ? 1 - this.mix * 0.5 : 0;
    this.wet.gain.setTargetAtTime(wet, t, T);
    this.dry.gain.setTargetAtTime(dry, t, T);
  }
  setBypass(b: boolean) {
    this.bypass = b;
    this.applyMix();
  }
  setParams(p: Record<string, number>) {
    this.params = { ...this.params, ...p };
    this.update(this.params);
    this.applyMix();
  }
  protected abstract update(p: Record<string, number>): void;
  dispose() {
    this.input.disconnect();
    this.output.disconnect();
  }
}

class Delay extends Base {
  private d: DelayNode;
  private fb: GainNode;
  constructor(id: string, ctx: AudioContext) {
    super(id, ctx);
    this.parallel = true;
    this.d = ctx.createDelay(2.5);
    this.fb = ctx.createGain();
    this.input.connect(this.d);
    this.d.connect(this.fb).connect(this.d);
    this.d.connect(this.wet);
  }
  update(p: Record<string, number>) {
    const t = this.ctx.currentTime;
    this.d.delayTime.setTargetAtTime(p.time / 1000, t, 0.05);
    this.fb.gain.setTargetAtTime(p.feedback / 100, t, T);
    this.mix = p.mix / 100;
  }
}

class Reverb extends Base {
  private conv: ConvolverNode;
  private pre: DelayNode;
  private lastDecay = -1;
  constructor(id: string, ctx: AudioContext) {
    super(id, ctx);
    this.parallel = true;
    this.pre = ctx.createDelay(0.5);
    this.conv = ctx.createConvolver();
    this.input.connect(this.pre).connect(this.conv).connect(this.wet);
  }
  update(p: Record<string, number>) {
    this.pre.delayTime.setTargetAtTime(p.predelay / 1000, this.ctx.currentTime, T);
    this.mix = p.mix / 100;
    if (Math.abs(p.decay - this.lastDecay) > 0.05) {
      this.lastDecay = p.decay;
      const sr = this.ctx.sampleRate;
      const len = Math.floor(sr * Math.min(8, p.decay * 1.2));
      const buf = this.ctx.createBuffer(2, len, sr);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const env = Math.pow(10, (-60 * (i / sr)) / p.decay / 20);
          lp = lp * 0.6 + (Math.random() * 2 - 1) * 0.4; // gentle HF damping
          d[i] = lp * env;
        }
      }
      this.conv.buffer = buf;
    }
  }
}

class Limiter extends Base {
  private drive: GainNode;
  private comp: DynamicsCompressorNode;
  constructor(id: string, ctx: AudioContext) {
    super(id, ctx);
    this.drive = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.knee.value = 0;
    this.comp.ratio.value = 20;
    this.comp.attack.value = 0.001;
    this.input.connect(this.drive).connect(this.comp).connect(this.wet);
  }
  update(p: Record<string, number>) {
    const t = this.ctx.currentTime;
    this.drive.gain.setTargetAtTime(dbToGain(p.drive), t, T);
    this.comp.threshold.setTargetAtTime(p.ceiling, t, T);
    this.comp.release.setTargetAtTime(p.release / 1000, t, T);
  }
}

class DeEsser extends Base {
  private lo: BiquadFilterNode;
  private hi: BiquadFilterNode;
  private comp: DynamicsCompressorNode;
  constructor(id: string, ctx: AudioContext) {
    super(id, ctx);
    this.lo = ctx.createBiquadFilter();
    this.lo.type = 'lowpass';
    this.hi = ctx.createBiquadFilter();
    this.hi.type = 'highpass';
    this.lo.Q.value = this.hi.Q.value = 0.5;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.attack.value = 0.002;
    this.comp.release.value = 0.06;
    this.comp.knee.value = 3;
    this.input.connect(this.lo).connect(this.wet);
    this.input.connect(this.hi).connect(this.comp).connect(this.wet);
  }
  update(p: Record<string, number>) {
    const t = this.ctx.currentTime;
    this.lo.frequency.setTargetAtTime(p.freq, t, T);
    this.hi.frequency.setTargetAtTime(p.freq, t, T);
    this.comp.threshold.setTargetAtTime(p.threshold, t, T);
    // ratio approximates the max reduction "range"
    this.comp.ratio.setTargetAtTime(1 + p.range / 2, t, T);
  }
}

class Tilt extends Base {
  private ls: BiquadFilterNode;
  private hs: BiquadFilterNode;
  private out: GainNode;
  constructor(id: string, ctx: AudioContext) {
    super(id, ctx);
    this.ls = ctx.createBiquadFilter();
    this.ls.type = 'lowshelf';
    this.hs = ctx.createBiquadFilter();
    this.hs.type = 'highshelf';
    this.out = ctx.createGain();
    this.input.connect(this.ls).connect(this.hs).connect(this.out).connect(this.wet);
  }
  update(p: Record<string, number>) {
    const t = this.ctx.currentTime;
    this.ls.frequency.setTargetAtTime(p.pivot, t, T);
    this.hs.frequency.setTargetAtTime(p.pivot, t, T);
    this.ls.gain.setTargetAtTime(-p.tilt, t, T);
    this.hs.gain.setTargetAtTime(p.tilt, t, T);
    this.out.gain.setTargetAtTime(dbToGain(p.output), t, T);
  }
}

class Width extends Base {
  private gains: GainNode[];
  constructor(id: string, ctx: AudioContext) {
    super(id, ctx);
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    // LL, RL, RR, LR
    this.gains = [0, 1, 2, 3].map(() => ctx.createGain());
    this.input.connect(split);
    split.connect(this.gains[0], 0).connect(merge, 0, 0);
    split.connect(this.gains[1], 1).connect(merge, 0, 0);
    split.connect(this.gains[2], 1).connect(merge, 0, 1);
    split.connect(this.gains[3], 0).connect(merge, 0, 1);
    merge.connect(this.wet);
  }
  update(p: Record<string, number>) {
    const w = p.width / 100;
    const t = this.ctx.currentTime;
    const same = (1 + w) / 2;
    const cross = (1 - w) / 2;
    this.gains[0].gain.setTargetAtTime(same, t, T);
    this.gains[2].gain.setTargetAtTime(same, t, T);
    this.gains[1].gain.setTargetAtTime(cross, t, T);
    this.gains[3].gain.setTargetAtTime(cross, t, T);
  }
}

const FACTORIES: Record<string, new (id: string, ctx: AudioContext) => Base> = {
  'builtin.delay': Delay,
  'builtin.reverb': Reverb,
  'builtin.limiter': Limiter,
  'builtin.deesser': DeEsser,
  'builtin.geq': Tilt,
  'builtin.width': Width,
};

export function createPlugin(ctx: AudioContext, pluginId: string): PluginInstance | null {
  const desc = getPlugin(pluginId);
  const F = FACTORIES[pluginId];
  if (!desc || !F) return null; // e.g. a VST3 that only exists in the native host
  return new F(pluginId, ctx);
}

/**
 * A chain of insert slots between `input` and `output`. Rebuilds wiring only when
 * the slot list (ids / plugin types) changes; otherwise just pushes parameters.
 */
export class InsertChain {
  readonly input: GainNode;
  readonly output: GainNode;
  private instances: { slotId: string; inst: PluginInstance | null }[] = [];
  private signature = '';
  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.input.connect(this.output);
  }
  sync(slots: { id: string; pluginId: string; bypass: boolean; params: Record<string, number> }[]) {
    const sig = slots.map((s) => `${s.id}:${s.pluginId}`).join('|');
    if (sig !== this.signature) {
      this.signature = sig;
      this.input.disconnect();
      const keep = new Map(this.instances.map((i) => [i.slotId, i]));
      const next = slots.map((s) => {
        const existing = keep.get(s.id);
        if (existing && existing.inst?.pluginId === s.pluginId) {
          keep.delete(s.id);
          existing.inst?.output.disconnect();
          return existing;
        }
        return { slotId: s.id, inst: createPlugin(this.ctx, s.pluginId) };
      });
      for (const old of keep.values()) old.inst?.dispose();
      this.instances = next;
      let node: AudioNode = this.input;
      for (const { inst } of next) {
        if (!inst) continue;
        node.connect(inst.input);
        node = inst.output;
      }
      node.connect(this.output);
    }
    slots.forEach((s, i) => {
      const inst = this.instances[i]?.inst;
      if (!inst) return;
      inst.setParams(s.params);
      inst.setBypass(s.bypass);
    });
  }
}
