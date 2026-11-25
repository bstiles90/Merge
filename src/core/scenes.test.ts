import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultState } from './defaults';
import { applyScene, takeSnapshot } from './scenes';
import { startSceneFade } from './sceneFade';
import type { ConsoleState, InsertSlot } from './types';

const ins = (id: string, extra: Partial<InsertSlot> = {}): InsertSlot => ({ id, pluginId: 'vst3.x', bypass: false, params: {}, ...extra });
const ch = (s: ConsoleState, id: string) => s.channels.find((c) => c.id === id)!;
const withCh = (s: ConsoleState, id: string, patch: Partial<ConsoleState['channels'][number]>): ConsoleState => ({
  ...s,
  channels: s.channels.map((c) => (c.id === id ? { ...c, ...patch } : c)),
});

describe('scene recall safes', () => {
  // scene: ch1 at 0 dB, panned left, muted, with plugin A; now: ch1 at -20, centre, unmuted, plugin B
  const base = withCh(defaultState(), 'ch1', { faderDb: 0, pan: -1, mute: true, inserts: [ins('A', { state: 'sceneA' })] });
  const scene = { id: 'sc1', name: 'S', snapshot: takeSnapshot(base) };
  const now = withCh(base, 'ch1', { faderDb: -20, pan: 0, mute: false, inserts: [ins('B', { state: 'liveB' })] });

  it('no safes: everything recalls', () => {
    const r = ch(applyScene(now, scene), 'ch1');
    expect([r.faderDb, r.pan, r.mute, r.inserts.map((i) => i.id)]).toEqual([0, -1, true, ['A']]);
  });
  it('part safes keep just those parts', () => {
    const r = ch(applyScene(withCh(now, 'ch1', { safe: { fader: true, pan: true } }), scene), 'ch1');
    expect([r.faderDb, r.pan, r.mute]).toEqual([-20, 0, true]);
  });
  it('whole-strip safe keeps everything', () => {
    const r = ch(applyScene(withCh(now, 'ch1', { recallSafe: true }), scene), 'ch1');
    expect([r.faderDb, r.mute, r.inserts[0].id]).toEqual([-20, false, 'B']);
  });
  it('a locked plugin slot stays (with its settings) while the rest of the rack recalls', () => {
    const live = withCh(now, 'ch1', { inserts: [ins('B', { state: 'liveB', recallSafe: true })] });
    const r = ch(applyScene(live, scene), 'ch1');
    expect(r.inserts.map((i) => [i.id, i.state])).toEqual([['B', 'liveB'], ['A', 'sceneA']]);
  });
  it('input source and mono/stereo are never recalled', () => {
    const live = withCh(now, 'ch1', { stereo: true, source: { kind: 'input', freq: 1000, deviceChannel: 9 } });
    const r = ch(applyScene(live, scene), 'ch1');
    expect(r.stereo).toBe(true);
    expect(r.source.deviceChannel).toBe(9);
  });
});

describe('scene fades', () => {
  afterEach(() => vi.useRealTimers());
  it('faders glide over the fade time (mute switches at the start); a hand move takes over', () => {
    vi.useFakeTimers();
    const from = withCh(defaultState(), 'ch1', { faderDb: -40, mute: false });
    const to = withCh(from, 'ch1', { faderDb: 0, mute: true });
    let state = from;
    const get = () => state;
    const set = (p: Partial<ConsoleState>) => (state = { ...state, ...p });
    startSceneFade(from, to, 1000, get, set);
    expect(ch(state, 'ch1').mute).toBe(true);
    expect(ch(state, 'ch1').faderDb).toBe(-40);
    vi.advanceTimersByTime(500);
    const mid = ch(state, 'ch1').faderDb;
    expect(mid).toBeGreaterThan(-28);
    expect(mid).toBeLessThan(-12);
    vi.advanceTimersByTime(600);
    expect(ch(state, 'ch1').faderDb).toBe(0);

    // a second fade, grabbed by hand halfway: that fader stays where the hand put it
    startSceneFade(state, from, 1000, get, set);
    vi.advanceTimersByTime(400);
    state = withCh(state, 'ch1', { faderDb: -6 });
    vi.advanceTimersByTime(800);
    expect(ch(state, 'ch1').faderDb).toBe(-6);
  });
});
