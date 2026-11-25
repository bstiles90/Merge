import { describe, expect, it } from 'vitest';
import { defaultState, NUM_BUSES } from './defaults';
import { buildMixPlan, busOrder, busTarget, createsLoop } from './plan';
import { parseShow, serializeShow } from './store';
import type { ConsoleState } from './types';

const withBuses = (s: ConsoleState, patch: Record<string, Partial<ConsoleState['buses'][number]>>): ConsoleState => ({
  ...s,
  buses: s.buses.map((b) => (patch[b.id] ? { ...b, ...patch[b.id] } : b)),
});

describe('routing', () => {
  it('has 64 buses; new buses go to Main LR, the demo feeds (1-8) go nowhere', () => {
    const s = defaultState();
    expect(s.buses.length).toBe(NUM_BUSES);
    expect(NUM_BUSES).toBe(64);
    expect(s.buses[0].output).toBe('none');
    expect(s.buses[20].output).toBe('main');
  });

  it('kick → Drums only (not Main LR): the plan carries an output assignment, panned like main', () => {
    let s = defaultState();
    s = { ...s, channels: s.channels.map((c) => (c.id === 'ch1' ? { ...c, mainAssign: false, routes: ['bus9'], faderDb: 0, mute: false } : c)) };
    const plan = buildMixPlan(s) as any;
    const ch1 = plan.channels[0];
    expect(ch1.main).toBe(0);
    expect(ch1.sends).toContainEqual({ bus: 'bus9', gain: 1, pre: false, route: true });
    expect(plan.buses.find((b: any) => b.id === 'bus9').to).toBe('main');
  });

  it('bus → bus → Main LR, processed in order (sources first)', () => {
    const s = withBuses(defaultState(), { bus9: { output: 'bus10' }, bus10: { output: 'bus11' }, bus11: { output: 'main' } });
    expect(busTarget(s, 'bus9')).toBe('bus10');
    const order = busOrder(s);
    expect(order.indexOf('bus9')).toBeLessThan(order.indexOf('bus10'));
    expect(order.indexOf('bus10')).toBeLessThan(order.indexOf('bus11'));
  });

  it('loops are refused', () => {
    const s = withBuses(defaultState(), { bus9: { output: 'bus10' }, bus10: { output: 'main' } });
    expect(createsLoop(s, 'bus10', 'bus9')).toBe(true);
    expect(createsLoop(s, 'bus12', 'bus9')).toBe(false);
    const looped = withBuses(s, { bus10: { output: 'bus9' } });
    expect([busTarget(looped, 'bus9'), busTarget(looped, 'bus10')]).toContain('');
  });

  it('an older show keeps its 8 buses as feeds and gets the other 56', () => {
    const old = JSON.parse(serializeShow(defaultState()));
    old.show.buses = old.show.buses.slice(0, 8).map((b: any) => {
      const { output: _o, ...rest } = b;
      return { ...rest, name: 'Old ' + b.id };
    });
    old.show.channels = old.show.channels.map((c: any) => {
      const { routes: _r, ...rest } = c;
      return rest;
    });
    const s = parseShow(JSON.stringify(old));
    expect(s.buses.length).toBe(64);
    expect(s.buses[0].name).toBe('Old bus1');
    expect(s.buses[0].output).toBe('none');
    expect(s.buses[40].output).toBe('main');
    expect(s.channels[0].routes).toEqual([]);
  });
});
