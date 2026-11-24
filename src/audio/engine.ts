// Web Audio engine. It owns the audio graph and follows the console state: it
// never writes mix state itself (except adding recorded clips). The same
// "state in, audio out" contract is what a native engine implements.

import { anySolo, computeBusGain, computeChannelGains, computeMainGain, computeMonitorGain, dbToGain } from '../core/mix';
import { newId } from '../core/defaults';
import { services } from '../core/services';
import { stateOnly, useConsole } from '../core/store';
import type { Bus, Channel, ConsoleState, IoState } from '../core/types';
import { openInput, type OpenInput } from './devices';
import { addMedia, getAudioBuffer } from './media';
import { InsertChain } from './pluginHost';
import { pinkNoise, speech } from './testSignals';
import { loadWorklets } from './worklets';

const T = 0.012; // smoothing time constant for gain changes (no zipper/clicks)

const lastValue = new WeakMap<AudioParam, number>();
function setP(p: AudioParam, v: number, ctx: BaseAudioContext, tc = T) {
  if (!isFinite(v)) v = 0;
  if (lastValue.get(p) === v) return;
  lastValue.set(p, v);
  p.setTargetAtTime(v, ctx.currentTime, tc);
}

export interface MeterReading {
  peak: number; // linear, L (or mono)
  peakR?: number;
  gr?: number; // compressor gain reduction dB (negative)
}

export interface LoudnessReading {
  momentary: number;
  shortTerm: number;
  integrated: number;
  peak: [number, number];
}

class Recorder {
  node: AudioWorkletNode;
  private chunks: Float32Array[][] = [];
  private done: ((data: Float32Array[]) => void) | null = null;
  constructor(ctx: AudioContext, private channels: number) {
    this.node = new AudioWorkletNode(ctx, 'merge-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: channels,
      channelCountMode: 'explicit',
      processorOptions: { channels },
    });
    this.node.port.onmessage = (e) => {
      if (e.data.chunk) this.chunks.push(e.data.chunk);
      if (e.data.done && this.done) {
        const len = this.chunks.reduce((a, c) => a + c[0].length, 0);
        const out = Array.from({ length: this.channels }, () => new Float32Array(len));
        let o = 0;
        for (const c of this.chunks) {
          c.forEach((d, i) => out[i].set(d, o));
          o += c[0].length;
        }
        this.chunks = [];
        this.done(out);
        this.done = null;
      }
    };
  }
  start() {
    this.chunks = [];
    this.node.port.postMessage('start');
  }
  stop(): Promise<Float32Array[]> {
    return new Promise((res) => {
      this.done = res;
      this.node.port.postMessage('stop');
    });
  }
}

class StereoMeter {
  split: ChannelSplitterNode;
  a: AnalyserNode[];
  constructor(ctx: AudioContext, src: AudioNode) {
    this.split = ctx.createChannelSplitter(2);
    this.a = [ctx.createAnalyser(), ctx.createAnalyser()];
    src.connect(this.split);
    this.a.forEach((an, i) => {
      an.fftSize = 512;
      this.split.connect(an, i);
    });
  }
}

function peakOf(an: AnalyserNode, scratch: Float32Array<ArrayBuffer>) {
  an.getFloatTimeDomainData(scratch);
  let m = 0;
  for (let i = 0; i < scratch.length; i++) {
    const v = Math.abs(scratch[i]);
    if (v > m) m = v;
  }
  return m;
}

class ChannelStrip {
  live: GainNode;
  pb: GainNode;
  srcIn: GainNode;
  inGain: GainNode;
  delay: DelayNode;
  hpf: BiquadFilterNode;
  gate: AudioWorkletNode;
  eq: BiquadFilterNode[];
  comp: DynamicsCompressorNode;
  makeup: GainNode;
  inserts: InsertChain;
  pre: GainNode;
  meter: AnalyserNode;
  fader: GainNode;
  panner: StereoPannerNode;
  mainSend: GainNode;
  cuePre: GainNode;
  cuePost: GainNode;
  sends = new Map<string, { pre: GainNode; post: GainNode }>();
  recorder: Recorder;
  sourceNodes: AudioNode[] = [];
  sourceKey = '';
  prev: Channel | null = null;
  playing: AudioBufferSourceNode[] = [];

  constructor(private eng: Engine, public id: string) {
    const ctx = eng.ctx;
    this.live = ctx.createGain();
    this.pb = ctx.createGain();
    this.srcIn = ctx.createGain();
    this.srcIn.channelCount = 1;
    this.srcIn.channelCountMode = 'explicit';
    this.live.connect(this.srcIn);
    this.pb.connect(this.srcIn);
    this.inGain = ctx.createGain();
    this.delay = ctx.createDelay(1);
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = 'highpass';
    this.hpf.Q.value = 0.707;
    this.gate = new AudioWorkletNode(ctx, 'merge-gate', { outputChannelCount: [1] });
    this.eq = [0, 1, 2, 3].map(() => ctx.createBiquadFilter());
    this.comp = ctx.createDynamicsCompressor();
    this.comp.knee.value = 6;
    this.makeup = ctx.createGain();
    this.inserts = new InsertChain(ctx);
    this.pre = ctx.createGain();
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 512;
    this.fader = ctx.createGain();
    this.panner = ctx.createStereoPanner();
    this.mainSend = ctx.createGain();
    this.cuePre = ctx.createGain();
    this.cuePost = ctx.createGain();

    let n: AudioNode = this.srcIn.connect(this.inGain).connect(this.delay).connect(this.hpf).connect(this.gate);
    for (const b of this.eq) n = n.connect(b);
    n.connect(this.comp).connect(this.makeup).connect(this.inserts.input);
    this.inserts.output.connect(this.pre);
    this.pre.connect(this.meter);
    this.pre.connect(this.fader).connect(this.panner).connect(this.mainSend).connect(eng.mainIn);
    this.pre.connect(this.cuePre).connect(eng.cueIn);
    this.panner.connect(this.cuePost).connect(eng.cueIn);
    for (const g of [this.mainSend, this.cuePre, this.cuePost, this.fader]) g.gain.value = 0;

    this.recorder = new Recorder(ctx, 1);
    this.srcIn.connect(this.recorder.node);
  }

  ensureSend(bus: string) {
    let s = this.sends.get(bus);
    if (!s) {
      const ctx = this.eng.ctx;
      s = { pre: ctx.createGain(), post: ctx.createGain() };
      s.pre.gain.value = 0;
      s.post.gain.value = 0;
      const target = this.eng.buses.get(bus)!.in;
      this.pre.connect(s.pre).connect(target);
      this.panner.connect(s.post).connect(target);
      this.sends.set(bus, s);
    }
    return s;
  }

  syncSource(ch: Channel) {
    const key = JSON.stringify(ch.source);
    if (key === this.sourceKey) return;
    this.sourceKey = key;
    for (const node of this.sourceNodes) {
      try {
        (node as AudioScheduledSourceNode).stop?.();
      } catch {
        /* not started */
      }
      node.disconnect();
    }
    this.sourceNodes = [];
    const ctx = this.eng.ctx;
    const src = ch.source;
    if (src.kind === 'tone') {
      const o = ctx.createOscillator();
      o.frequency.value = src.freq;
      const g = ctx.createGain();
      g.gain.value = dbToGain(-18);
      o.connect(g).connect(this.live);
      o.start();
      this.sourceNodes.push(o, g);
    } else if (src.kind === 'noise' || src.kind === 'speech') {
      const b = ctx.createBufferSource();
      b.buffer = src.kind === 'noise' ? pinkNoise(ctx) : speech(ctx, src.freq);
      b.loop = true;
      b.connect(this.live);
      b.start(0, Math.random() * b.buffer.duration);
      this.sourceNodes.push(b);
    } else if (src.kind === 'input' && src.deviceId) {
      const devCh = src.deviceChannel ?? 0;
      this.eng.getInput(src.deviceId).then((inp) => {
        if (!inp || this.sourceKey !== key) return;
        const g = ctx.createGain();
        inp.splitter.connect(g, Math.min(devCh, inp.channels - 1));
        g.connect(this.live);
        this.sourceNodes.push(g);
      });
    }
  }

  syncStatic(ch: Channel) {
    const ctx = this.eng.ctx;
    this.syncSource(ch);
    setP(this.live.gain, ch.inputMode === 'live' ? 1 : 0, ctx);
    setP(this.pb.gain, ch.inputMode === 'playback' ? 1 : 0, ctx);
    setP(this.inGain.gain, dbToGain(ch.gainDb) * (ch.phaseInvert ? -1 : 1), ctx);
    setP(this.delay.delayTime, ch.delayMs / 1000, ctx);
    setP(this.hpf.frequency, ch.hpf.on ? ch.hpf.freq : 5, ctx);
    const gp = this.gate.parameters as Map<string, AudioParam>;
    gp.get('enabled')!.value = ch.gate.on ? 1 : 0;
    gp.get('threshold')!.value = ch.gate.threshold;
    gp.get('range')!.value = ch.gate.rangeDb;
    gp.get('attack')!.value = ch.gate.attack;
    gp.get('release')!.value = ch.gate.release;
    ch.eq.bands.forEach((b, i) => {
      const f = this.eq[i];
      if (f.type !== b.type) f.type = b.type;
      setP(f.frequency, b.freq, ctx);
      setP(f.gain, ch.eq.on ? b.gainDb : 0, ctx);
      setP(f.Q, b.q, ctx);
    });
    const c = ch.comp;
    setP(this.comp.threshold, c.on ? c.threshold : 0, ctx);
    setP(this.comp.ratio, c.on ? c.ratio : 1, ctx);
    setP(this.comp.attack, c.attack / 1000, ctx);
    setP(this.comp.release, c.release / 1000, ctx);
    setP(this.makeup.gain, c.on ? dbToGain(c.makeupDb) : 1, ctx);
    setP(this.panner.pan, ch.pan, ctx);
    this.inserts.sync(ch.inserts);
  }

  syncGains(s: ConsoleState, ch: Channel) {
    const ctx = this.eng.ctx;
    const g = computeChannelGains(s, ch);
    setP(this.fader.gain, g.post, ctx);
    setP(this.mainSend.gain, g.main ? 1 : 0, ctx);
    setP(this.cuePre.gain, g.cuePre ? g.cue : 0, ctx);
    // AFL taps after the fader, so the post gain is already applied
    setP(this.cuePost.gain, !g.cuePre && g.cue ? 1 : 0, ctx);
    for (const [busId, sg] of Object.entries(g.sends)) {
      if (!sg.gain && !this.sends.has(busId)) continue;
      const sn = this.ensureSend(busId);
      // post sends tap after the fader node, so divide out the fader gain
      setP(sn.pre.gain, sg.pre ? sg.gain : 0, ctx);
      setP(sn.post.gain, !sg.pre && g.post > 0 ? sg.gain / g.post : 0, ctx);
    }
  }
}

class BusStrip {
  in: GainNode;
  delay: DelayNode;
  inserts: InsertChain;
  preFader: GainNode;
  fader: GainNode;
  out: GainNode;
  cuePre: GainNode;
  cuePost: GainNode;
  meter: StereoMeter;
  prev: Bus | null = null;
  constructor(private eng: Engine, public id: string) {
    const ctx = eng.ctx;
    this.in = ctx.createGain();
    this.in.channelCount = 2;
    this.in.channelCountMode = 'explicit';
    this.delay = ctx.createDelay(1);
    this.inserts = new InsertChain(ctx);
    this.preFader = ctx.createGain();
    this.fader = ctx.createGain();
    this.out = ctx.createGain();
    this.cuePre = ctx.createGain();
    this.cuePost = ctx.createGain();
    this.cuePre.gain.value = 0;
    this.cuePost.gain.value = 0;
    this.in.connect(this.delay).connect(this.inserts.input);
    this.inserts.output.connect(this.preFader).connect(this.fader).connect(this.out);
    this.preFader.connect(this.cuePre).connect(eng.cueIn);
    this.out.connect(this.cuePost).connect(eng.cueIn);
    this.meter = new StereoMeter(ctx, this.out);
  }
  sync(s: ConsoleState, b: Bus) {
    const ctx = this.eng.ctx;
    if (b !== this.prev) {
      setP(this.delay.delayTime, b.delayMs / 1000, ctx);
      this.inserts.sync(b.inserts);
      this.prev = b;
    }
    const g = computeBusGain(s, b);
    setP(this.fader.gain, g.out, ctx);
    const pfl = s.monitor.soloMode === 'pfl';
    setP(this.cuePre.gain, b.solo && pfl ? 1 : 0, ctx);
    setP(this.cuePost.gain, b.solo && !pfl ? 1 : 0, ctx);
  }
}

export class Engine {
  ctx: AudioContext;
  mainIn!: GainNode;
  mainInserts!: InsertChain;
  mainDelay!: DelayNode;
  mainFader!: GainNode;
  mainOut!: GainNode;
  mainMeter!: StereoMeter;
  mainRecorder!: Recorder;
  loudnessNode!: AudioWorkletNode;
  loudness: LoudnessReading = { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, peak: [0, 0] };
  cueIn!: GainNode;
  monitorSel = new Map<string, GainNode>();
  monitorGain!: GainNode;
  monitorMeter!: StereoMeter;
  outputMerger!: ChannelMergerNode;
  outputSplitters = new Map<string, ChannelSplitterNode>();
  talkbackIn!: GainNode;
  talkbackSends = new Map<string, GainNode>();
  talkbackKey = '';
  channels = new Map<string, ChannelStrip>();
  buses = new Map<string, BusStrip>();
  inputs = new Map<string, Promise<OpenInput | null>>();
  openInputs = new Map<string, OpenInput>();
  private prev: ConsoleState | null = null;
  private ioKey = '';
  private scratch = new Float32Array(512);
  private clock = { startCtx: 0, startPos: 0 };
  private recording: { startPos: number; channels: string[]; program: boolean } | null = null;
  private listeners = new Set<() => void>();

  private constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  static async start(): Promise<Engine> {
    const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    await loadWorklets(ctx);
    const e = new Engine(ctx);
    e.build();
    await ctx.resume();
    return e;
  }

  get outputChannels() {
    return this.ctx.destination.channelCount;
  }
  get maxOutputChannels() {
    return this.ctx.destination.maxChannelCount;
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((l) => l());
  }

  private build() {
    const ctx = this.ctx;
    const s = stateOnly(useConsole.getState());
    this.cueIn = ctx.createGain();
    this.mainIn = ctx.createGain();
    this.mainIn.channelCount = 2;
    this.mainIn.channelCountMode = 'explicit';
    this.mainInserts = new InsertChain(ctx);
    this.mainDelay = ctx.createDelay(2);
    this.mainFader = ctx.createGain();
    this.mainOut = ctx.createGain();
    this.mainIn.connect(this.mainInserts.input);
    this.mainInserts.output.connect(this.mainDelay).connect(this.mainFader).connect(this.mainOut);
    this.mainMeter = new StereoMeter(ctx, this.mainOut);
    this.loudnessNode = new AudioWorkletNode(ctx, 'merge-loudness', {
      numberOfOutputs: 0,
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    this.loudnessNode.port.onmessage = (e) => {
      this.loudness = e.data;
    };
    this.mainOut.connect(this.loudnessNode);
    this.mainRecorder = new Recorder(ctx, 2);
    this.mainOut.connect(this.mainRecorder.node);

    for (const b of s.buses) this.buses.set(b.id, new BusStrip(this, b.id));
    for (const c of s.channels) this.channels.set(c.id, new ChannelStrip(this, c.id));

    // monitor: pick main / a bus / the cue bus (automatically when anything is soloed)
    this.monitorGain = ctx.createGain();
    const addSel = (key: string, node: AudioNode) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      node.connect(g).connect(this.monitorGain);
      this.monitorSel.set(key, g);
    };
    addSel('main', this.mainOut);
    addSel('cue', this.cueIn);
    for (const [id, b] of this.buses) addSel(id, b.out);
    this.monitorMeter = new StereoMeter(ctx, this.monitorGain);

    this.talkbackIn = ctx.createGain();
    this.talkbackIn.gain.value = 0;

    services.playhead = () => this.playhead();
    this.sync(s);
    useConsole.subscribe((st) => this.sync(stateOnly(st)));
  }

  playhead(): number {
    const s = useConsole.getState().transport;
    if (!s.playing) return s.position;
    return this.clock.startPos + (this.ctx.currentTime - this.clock.startCtx);
  }

  getInput(deviceId: string): Promise<OpenInput | null> {
    let p = this.inputs.get(deviceId);
    if (!p) {
      p = openInput(this.ctx, deviceId)
        .then((inp) => {
          this.openInputs.set(deviceId, inp);
          this.emit();
          return inp;
        })
        .catch((err) => {
          console.error('Failed to open input', deviceId, err);
          this.inputs.delete(deviceId);
          return null;
        });
      this.inputs.set(deviceId, p);
    }
    return p;
  }

  async setOutputDevice(deviceId: string | undefined) {
    const anyCtx = this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (anyCtx.setSinkId) await anyCtx.setSinkId(deviceId ?? '');
    this.ioKey = '';
    this.syncOutputs(stateOnly(useConsole.getState()).io, true);
    this.emit();
  }

  private splitterFor(src: string): ChannelSplitterNode | null {
    let sp = this.outputSplitters.get(src);
    if (sp) return sp;
    const node = src === 'main' ? this.mainOut : src === 'monitor' ? this.monitorGain : this.buses.get(src)?.out;
    if (!node) return null;
    sp = this.ctx.createChannelSplitter(2);
    node.connect(sp);
    this.outputSplitters.set(src, sp);
    return sp;
  }

  private syncOutputs(io: IoState, force = false) {
    const key = JSON.stringify(io.outputPatch);
    if (!force && key === this.ioKey) return;
    this.ioKey = key;
    const dest = this.ctx.destination;
    const n = Math.max(2, Math.min(dest.maxChannelCount, io.outputPatch.length));
    try {
      dest.channelCount = n;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'discrete';
    } catch {
      /* some devices refuse – stay stereo */
    }
    this.outputMerger?.disconnect();
    for (const sp of this.outputSplitters.values()) sp.disconnect();
    this.outputSplitters.clear();
    const ch = dest.channelCount;
    this.outputMerger = this.ctx.createChannelMerger(ch);
    io.outputPatch.slice(0, ch).forEach((o, i) => {
      if (!o) return;
      const sp = this.splitterFor(o.src);
      sp?.connect(this.outputMerger, o.side, i);
    });
    this.outputMerger.connect(dest);
  }

  private syncTalkback(s: ConsoleState) {
    const tb = s.talkback;
    const key = `${tb.deviceId}|${tb.deviceChannel}`;
    if (key !== this.talkbackKey) {
      this.talkbackKey = key;
      this.talkbackIn.disconnect();
      this.talkbackSends.clear();
      if (tb.deviceId) {
        this.getInput(tb.deviceId).then((inp) => {
          if (inp) inp.splitter.connect(this.talkbackIn, Math.min(tb.deviceChannel, inp.channels - 1));
        });
      }
    }
    setP(this.talkbackIn.gain, tb.active ? dbToGain(tb.levelDb) : 0, this.ctx);
    for (const [id, b] of this.buses) {
      let g = this.talkbackSends.get(id);
      if (!g) {
        g = this.ctx.createGain();
        g.gain.value = 0;
        this.talkbackIn.connect(g).connect(b.in);
        this.talkbackSends.set(id, g);
      }
      setP(g.gain, tb.destinations.includes(id) ? 1 : 0, this.ctx);
    }
  }

  sync(s: ConsoleState) {
    const ctx = this.ctx;
    for (const ch of s.channels) {
      const strip = this.channels.get(ch.id);
      if (!strip) continue;
      if (strip.prev !== ch) {
        strip.syncStatic(ch);
        strip.prev = ch;
      }
      strip.syncGains(s, ch);
    }
    for (const b of s.buses) this.buses.get(b.id)?.sync(s, b);

    if (!this.prev || this.prev.main !== s.main) {
      this.mainInserts.sync(s.main.inserts);
      setP(this.mainDelay.delayTime, s.main.delayMs / 1000, ctx);
    }
    setP(this.mainFader.gain, computeMainGain(s), ctx);

    const solo = anySolo(s);
    const monSrc = solo ? 'cue' : s.monitor.source;
    for (const [k, g] of this.monitorSel) setP(g.gain, k === monSrc ? 1 : 0, ctx);
    // talkback dims the control-room monitor to avoid feedback
    const tbDim = s.talkback.active ? dbToGain(-20) : 1;
    setP(this.monitorGain.gain, computeMonitorGain(s) * tbDim, ctx);

    this.syncOutputs(s.io);
    this.syncTalkback(s);
    this.syncTransport(s);
    this.prev = s;
  }

  // ---------------------------------------------------------------- transport
  private syncTransport(s: ConsoleState) {
    const p = this.prev?.transport;
    const t = s.transport;
    const wasPlaying = !!p?.playing;
    if (t.playing && !wasPlaying) {
      this.startPlayback(s, t.position);
    } else if (!t.playing && wasPlaying) {
      this.stopPlayback();
    } else if (t.playing && p && t.position !== p.position) {
      // seek while playing
      this.stopPlayback();
      this.startPlayback(s, t.position);
    }
    if (t.recording && !p?.recording) this.startRecording(s);
    else if (!t.recording && p?.recording) this.stopRecording();
  }

  private startPlayback(s: ConsoleState, pos: number) {
    const t0 = this.ctx.currentTime + 0.05;
    this.clock = { startCtx: t0, startPos: pos };
    for (const ch of s.channels) {
      if (ch.inputMode !== 'playback') continue;
      const strip = this.channels.get(ch.id)!;
      for (const clip of s.clips.filter((c) => c.trackId === ch.id)) {
        const end = clip.start + clip.duration;
        if (end <= pos) continue;
        const buf = getAudioBuffer(this.ctx, clip.bufferId);
        if (!buf) continue;
        const into = Math.max(0, pos - clip.start);
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(strip.pb);
        src.start(t0 + Math.max(0, clip.start - pos), clip.offset + into, clip.duration - into);
        strip.playing.push(src);
      }
    }
  }

  private stopPlayback() {
    for (const strip of this.channels.values()) {
      for (const src of strip.playing) {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
        src.disconnect();
      }
      strip.playing = [];
    }
  }

  private startRecording(s: ConsoleState) {
    const armed = s.channels.filter((c) => c.recArm).map((c) => c.id);
    this.recording = { startPos: this.playhead(), channels: armed, program: s.transport.recordProgram };
    for (const id of armed) this.channels.get(id)!.recorder.start();
    if (s.transport.recordProgram) this.mainRecorder.start();
  }

  private async stopRecording() {
    const rec = this.recording;
    if (!rec) return;
    this.recording = null;
    const sr = this.ctx.sampleRate;
    const jobs: Promise<{ trackId: string; data: Float32Array[] }>[] = rec.channels.map((id) =>
      this.channels
        .get(id)!
        .recorder.stop()
        .then((data) => ({ trackId: id, data })),
    );
    if (rec.program) jobs.push(this.mainRecorder.stop().then((data) => ({ trackId: 'pgm', data })));
    const results = await Promise.all(jobs);
    const st = useConsole.getState();
    const clips = results
      .filter((r) => r.data[0]?.length)
      .map((r) => {
        const bufferId = newId('buf');
        addMedia(bufferId, sr, r.data);
        const name = r.trackId === 'pgm' ? 'PGM' : st.channels.find((c) => c.id === r.trackId)?.name ?? r.trackId;
        const take = st.clips.filter((c) => c.trackId === r.trackId).length + 1;
        return {
          id: newId('clip'),
          trackId: r.trackId,
          name: `${name} #${take}`,
          start: rec.startPos,
          offset: 0,
          duration: r.data[0].length / sr,
          bufferId,
          channels: r.data.length,
        };
      });
    if (clips.length) useConsole.getState().update((s) => ({ clips: [...s.clips, ...clips] }));
  }

  // ------------------------------------------------------------------- meters
  readMeters(): Map<string, MeterReading> {
    const out = new Map<string, MeterReading>();
    const sc = this.scratch;
    for (const [id, strip] of this.channels) {
      out.set(id, { peak: peakOf(strip.meter, sc), gr: strip.comp.reduction });
    }
    for (const [id, b] of this.buses) out.set(id, { peak: peakOf(b.meter.a[0], sc), peakR: peakOf(b.meter.a[1], sc) });
    out.set('main', { peak: peakOf(this.mainMeter.a[0], sc), peakR: peakOf(this.mainMeter.a[1], sc) });
    out.set('monitor', { peak: peakOf(this.monitorMeter.a[0], sc), peakR: peakOf(this.monitorMeter.a[1], sc) });
    return out;
  }

  resetLoudness() {
    this.loudnessNode.port.postMessage('reset');
  }
}

let engine: Engine | null = null;
export function getEngine() {
  return engine;
}
export async function startEngine() {
  if (!engine) {
    engine = await Engine.start();
    (window as unknown as { __mergeEngine: Engine }).__mergeEngine = engine; // debugging / tests
  }
  return engine;
}
