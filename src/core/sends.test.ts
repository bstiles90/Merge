import { describe, expect, it } from 'vitest';
import { defaultState } from './defaults';
import { buildMixPlan } from './plan';
import { applyTapValue, tapCode } from './sends';
import type { ConsoleState, InsertSlot, Send } from './types';

const ins = (id: string): InsertSlot => ({ id, pluginId: 'vst3.x', bypass: false, params: {} });

function withSend(send: Send, inserts: InsertSlot[] = []): ConsoleState {
  const s = defaultState();
  return { ...s, channels: s.channels.map((c) => (c.id === 'ch1' ? { ...c, inserts, faderDb: -6, mute: false, sends: { bus9: send } } : c)) };
}
const planSend = (s: ConsoleState) => buildMixPlan(s).channels[0].sends.find((x: { bus: string }) => x.bus === 'bus9') as any;

describe('send tap points', () => {
  const base: Send = { on: true, levelDb: 0, pre: false };
  it('older sends: pre flag -> PRE, otherwise POST', () => {
    expect(planSend(withSend({ ...base, pre: true })).tap).toBe('pre');
    expect(planSend(withSend(base)).tap).toBe('post');
  });
  it('INPUT and PRE ignore the fader; POST and PSP follow it', () => {
    expect(planSend(withSend(applyTapValue(base, 'input'))).gain).toBeCloseTo(1);
    expect(planSend(withSend(applyTapValue(base, 'pre'))).gain).toBeCloseTo(1);
    expect(planSend(withSend(applyTapValue(base, 'post'))).gain).toBeCloseTo(0.501, 2);
    expect(planSend(withSend(applyTapValue(base, 'psp'))).gain).toBeCloseTo(0.501, 2);
  });
  it('custom PRE tap after a chosen plugin follows that plugin', () => {
    const rack = [ins('a'), ins('b'), ins('c')];
    const send = applyTapValue(base, 'pre:b');
    expect(send.pre).toBe(true);
    expect(planSend(withSend(send, rack)).after).toBe(2);
    expect(tapCode({ inserts: rack }, send)).toBe('P2');
    // plugin moved to the top: the tap moves with it
    expect(planSend(withSend(send, [ins('b'), ins('a'), ins('c')])).after).toBe(1);
    // plugin removed: falls back to after the whole rack
    const gone = planSend(withSend(send, [ins('a'), ins('c')]));
    expect(gone.after).toBeUndefined();
    expect(tapCode({ inserts: [ins('a'), ins('c')] }, send)).toBe('PRE');
  });
});

describe('stereo channels', () => {
  it('plan carries stereo and the right input (next input by default)', () => {
    const s = defaultState();
    const st: ConsoleState = { ...s, channels: s.channels.map((c) => (c.id === 'ch1' ? { ...c, stereo: true, source: { kind: 'input', freq: 1000, deviceId: 'native', deviceChannel: 4 } } : c)) };
    const p = buildMixPlan(st).channels[0] as any;
    expect(p.stereo).toBe(true);
    expect(p.src.input).toBe(4);
    expect(p.src.inputR).toBe(5);
    const mono = buildMixPlan(s).channels[0] as any;
    expect(mono.stereo).toBeUndefined();
  });
});
