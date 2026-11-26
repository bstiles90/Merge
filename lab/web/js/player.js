// Sample-aligned multi-version player.
//
// Every loaded version (and, for group audition, every group stem) is started at the same
// AudioContext time from the same offset, so they run in lockstep. Switching versions only
// changes gains (short crossfade): playback never restarts and the position never jumps.
// Long recordings are loaded in windows of WINDOW_S around the playhead.

import { wavHeader, wavFrames } from './wav.js';

const WINDOW_S = 8 * 60;      // beyond this, load windows instead of the whole file
const FULL_LIMIT_S = 12 * 60;

export class Player {
  constructor() {
    this.ctx = null; this.master = null;
    this.tracks = {};          // key -> {info, buf, gain, src}
    this.order = [];
    this.active = null;
    this.groups = {};          // group -> {version -> track key}
    this.groupMode = false; this.solo = new Set(); this.mute = new Set();
    this.playing = false; this.t0 = 0; this.ctxStart = 0;
    this.loop = null;          // {a, b}
    this.duration = 0; this.win = [0, 0];
    this.crossfade = 0.008; this.volumeDb = 0;
    this.listeners = new Set(); this.loading = false; this.trims = {};
    this._raf = null;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { this.listeners.forEach((f) => f(ev, this)); }
  ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'playback' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.setVolume(this.volumeDb);
    }
    return this.ctx;
  }

  // versions: [{key, url, trimDb?}]   groups: {group: {version: url}}
  async load(versions, groups = {}) {
    this.stop(); this.dispose();
    this.ensureCtx();
    this.loading = true; this.emit('loading');
    try {
      const all = [...versions.map((v) => ({ ...v, kind: 'mix' }))];
      for (const [g, byV] of Object.entries(groups)) for (const [v, url] of Object.entries(byV)) all.push({ key: `g:${g}:${v}`, url, kind: 'group', group: g, version: v });
      const infos = await Promise.all(all.map((t) => wavHeader(t.url)));
      all.forEach((t, i) => {
        const gain = this.ctx.createGain(); gain.gain.value = 0; gain.connect(this.master);
        this.tracks[t.key] = { ...t, info: infos[i], gain, buf: null, src: null };
        if (t.kind === 'mix') this.order.push(t.key); else (this.groups[t.group] ||= {})[t.version] = t.key;
        if (t.trimDb) this.trims[t.key] = t.trimDb;
      });
      this.duration = Math.max(...infos.filter((x, i) => all[i].kind === 'mix').map((x) => x.duration));
      this.active = this.active && this.tracks[this.active] ? this.active : this.order[0];
      await this._loadWindow(0);
    } finally { this.loading = false; this.emit('loaded'); }
    this._applyGains(true);
  }
  dispose() {
    for (const t of Object.values(this.tracks)) { try { t.gain.disconnect(); } catch (e) {} }
    this.tracks = {}; this.order = []; this.groups = {}; this.trims = {};
  }
  get long() { return this.duration > FULL_LIMIT_S; }

  async _loadWindow(t) {
    const start = this.long ? Math.max(0, Math.min(t - 5, this.duration - WINDOW_S)) : 0;
    const len = this.long ? WINDOW_S : this.duration + 1;
    if (this.win[1] > this.win[0] && start >= this.win[0] - 1e-6 && t + 3 < this.win[1] && Object.values(this.tracks).every((x) => x.buf)) return;
    this.loading = true; this.emit('loading');
    const keys = Object.keys(this.tracks).filter((k) => this.tracks[k].kind === 'mix' || this.groupMode);
    const bufs = await Promise.all(keys.map((k) => {
      const tr = this.tracks[k];
      return wavFrames(this.ctx, tr.info, Math.round(start * tr.info.sampleRate), Math.round(len * tr.info.sampleRate));
    }));
    for (const k of Object.keys(this.tracks)) this.tracks[k].buf = null;
    keys.forEach((k, i) => { this.tracks[k].buf = bufs[i]; });
    this.win = [start, Math.min(this.duration, start + len)];
    this.loading = false; this.emit('loaded');
  }

  currentTime() {
    if (!this.playing) return this.t0;
    let t = this.t0 + (this.ctx.currentTime - this.ctxStart);
    if (this.loop && t >= this.loop.b) t = this.loop.a + ((t - this.loop.a) % (this.loop.b - this.loop.a));
    return Math.min(t, this.duration);
  }

  async play(from) {
    if (!this.order.length) return;
    this.ensureCtx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    let t = from ?? this.currentTime();
    if (t >= this.duration - 0.05) t = this.loop ? this.loop.a : 0;
    this._stopSources();
    await this._loadWindow(t);
    const when = this.ctx.currentTime + 0.06;
    for (const [k, tr] of Object.entries(this.tracks)) {
      if (!tr.buf) continue;
      const s = this.ctx.createBufferSource();
      s.buffer = tr.buf;
      if (this.loop && this.loop.a >= this.win[0] && this.loop.b <= this.win[1]) {
        s.loop = true; s.loopStart = this.loop.a - this.win[0]; s.loopEnd = this.loop.b - this.win[0];
      }
      s.connect(tr.gain);
      s.start(when, Math.max(0, t - this.win[0]));
      tr.src = s;
    }
    this.t0 = t; this.ctxStart = when; this.playing = true;
    this._applyGains(true);
    this.emit('play');
    this._tick();
  }
  pause() { if (!this.playing) return; this.t0 = this.currentTime(); this._stopSources(); this.playing = false; this.emit('pause'); }
  stop() { this._stopSources(); this.playing = false; this.t0 = this.loop ? this.loop.a : 0; this.emit('stop'); }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(t) {
    t = Math.max(0, Math.min(t, this.duration));
    if (this.playing) this.play(t); else { this.t0 = t; this.emit('seek'); }
  }
  setLoop(a, b) {
    this.loop = a == null || b == null || b - a < 0.2 ? null : { a, b };
    if (this.playing) this.play(this.loop && (this.currentTime() < this.loop.a || this.currentTime() > this.loop.b) ? this.loop.a : this.currentTime());
    this.emit('loop');
  }
  _stopSources() {
    for (const tr of Object.values(this.tracks)) { if (tr.src) { try { tr.src.stop(); tr.src.disconnect(); } catch (e) {} tr.src = null; } }
  }
  _tick() {
    cancelAnimationFrame(this._raf);
    const step = () => {
      if (!this.playing) return;
      const t = this.currentTime();
      if (!this.loop && t >= this.duration - 0.02) { this.stop(); return; }
      if (this.long && !this.loop && t > this.win[1] - 2 && this.win[1] < this.duration) { this.play(t); return; }
      this.emit('time');
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  setActive(key) {
    if (!this.tracks[key] || this.tracks[key].kind !== 'mix') return;
    this.active = key; this._applyGains(false); this.emit('active');
  }
  async setGroupMode(on) {
    this.groupMode = on && Object.keys(this.groups).length > 0;
    if (this.groupMode && Object.values(this.tracks).some((t) => t.kind === 'group' && !t.buf)) {
      const t = this.currentTime(), was = this.playing;
      this._stopSources(); this.playing = false; this.win = [0, 0];
      await this._loadWindow(t); this.t0 = t;
      if (was) await this.play(t);
    }
    this._applyGains(false); this.emit('groups');
  }
  toggleSolo(g) { this.solo.has(g) ? this.solo.delete(g) : this.solo.add(g); this._applyGains(false); this.emit('groups'); }
  toggleMute(g) { this.mute.has(g) ? this.mute.delete(g) : this.mute.add(g); this._applyGains(false); this.emit('groups'); }
  setVolume(db) {
    this.volumeDb = db;
    if (this.master) this.master.gain.setTargetAtTime(db <= -60 ? 0 : Math.pow(10, db / 20), this.ctx.currentTime, 0.01);
  }
  _target(k) {
    const tr = this.tracks[k];
    const trim = Math.pow(10, (this.trims[k] || 0) / 20);
    if (tr.kind === 'mix') return !this.groupMode && k === this.active ? trim : 0;
    const activeVersion = this.tracks[this.active]?.version ?? this.active;
    if (!this.groupMode || tr.version !== activeVersion) return 0;
    if (this.mute.has(tr.group)) return 0;
    if (this.solo.size && !this.solo.has(tr.group)) return 0;
    return 1;
  }
  _applyGains(instant) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const k of Object.keys(this.tracks)) {
      const g = this.tracks[k].gain.gain, v = this._target(k);
      g.cancelScheduledValues(now);
      if (instant) g.setValueAtTime(v, now);
      else { g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(v, now + this.crossfade); }
    }
  }
}
