import { describe, expect, it } from 'vitest';
import { runAction } from './actions';
import { defaultState } from './defaults';
import { dbToGain } from './mix';
import { buildMixPlan } from './plan';

describe('mix plan for the native engine', () => {
  it('resolves mute groups into channel gains', () => {
    const s = runAction(defaultState(), { type: 'muteGroup.toggle', args: { id: 'mg1' } });
    const p = buildMixPlan(s);
    expect(p.channels[0].post).toBe(0); // Host 1 in "Hosts"
    expect(p.channels[3].post).toBeCloseTo(dbToGain(-12), 5); // Remote isn't
  });

  it('carries mix-minus as computed sends', () => {
    const p = buildMixPlan(defaultState());
    const remote = p.channels[3];
    const host = p.channels[0];
    expect(remote.sends.find((x) => x.bus === 'bus7')).toBeUndefined();
    expect(host.sends.find((x) => x.bus === 'bus7')?.gain).toBeCloseTo(dbToGain(-12), 5);
  });

  it('switches the monitor to cue when anything is soloed', () => {
    const s = runAction(defaultState(), { type: 'channel.solo.toggle', args: { id: 'ch2' } });
    const p = buildMixPlan(s);
    expect(p.monitor.source).toBe('cue');
    expect(p.channels[1].cue).toBe(1);
    expect(p.channels[1].cuePre).toBe(true);
  });

  it('dims the monitor during talkback', () => {
    const s = defaultState();
    const on = runAction(s, { type: 'talkback.toggle', args: {} });
    expect(buildMixPlan(on).monitor.gain).toBeCloseTo(buildMixPlan(s).monitor.gain * dbToGain(-20), 6);
  });

  it('passes the program limiter settings through', () => {
    const s = defaultState();
    s.main.limiter = { on: true, ceilingDb: -1.5, releaseMs: 200 };
    expect(buildMixPlan(s).main.limiter).toEqual({ on: true, ceilingDb: -1.5, releaseMs: 200 });
  });

  it('lists inserts without heavy plugin state', () => {
    const s = defaultState();
    s.channels[0].inserts = [{ id: 'i1', pluginId: 'vst3:x', bypass: false, params: {}, state: 'AAAA'.repeat(1000) }];
    const p = buildMixPlan(s);
    expect(p.channels[0].inserts).toEqual([{ id: 'i1', pluginId: 'vst3:x', bypass: false }]);
  });
});
