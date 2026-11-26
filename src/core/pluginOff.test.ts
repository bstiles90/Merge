import { describe, expect, it } from 'vitest';
import { defaultState } from './defaults';
import { buildMixPlan } from './plan';
import { setSlotOffline, crashNotice } from './pluginOff';

describe('switching a crashed plugin off', () => {
  const base = () => {
    const s = defaultState();
    s.channels[2].name = 'Lead Vocal';
    s.channels[2].inserts = [
      { id: 'ins_a', pluginId: 'aucode:aufx,dees,Weis', pluginName: 'Weiss Deess', bypass: false, params: {}, state: 'b64:abc' },
      { id: 'ins_b', pluginId: 'aucode:aufx,comp,Abcd', bypass: false, params: {} },
    ];
    return s;
  };

  it('keeps the slot and its settings but leaves it out of the plan', () => {
    const { state, strip } = setSlotOffline(base(), 'ins_a', true);
    expect(strip).toBe('Lead Vocal');
    const slot = state.channels[2].inserts[0];
    expect(slot.offline).toBe(true);
    expect(slot.state).toBe('b64:abc');
    const plan = buildMixPlan(state);
    const ch = (plan as any).channels.find((c: any) => c.id === state.channels[2].id);
    expect(ch.inserts.map((i: any) => i.id)).toEqual(['ins_b']);
  });

  it('turns back on', () => {
    const off = setSlotOffline(base(), 'ins_a', true).state;
    const on = setSlotOffline(off, 'ins_a', false).state;
    expect('offline' in on.channels[2].inserts[0]).toBe(false);
  });

  it('reports a slot it can\'t find', () => {
    expect(setSlotOffline(base(), 'nope', true).strip).toBeNull();
  });

  it('names the plugin and strip in the notice', () => {
    expect(crashNotice({ kind: 'render', slotId: 'ins_a', name: 'Weiss Deess' }, 'Lead Vocal')).toMatch(/Weiss Deess on Lead Vocal/);
  });
});
