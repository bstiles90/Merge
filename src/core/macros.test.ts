import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultState } from './defaults';
import { runMacro } from './macros';
import { timedSteps } from './actions';
import type { ConsoleState, Macro } from './types';

const fader = (s: ConsoleState, id: string) => s.channels.find((c) => c.id === id)!.faderDb;

describe('macros', () => {
  afterEach(() => vi.useRealTimers());
  it('moves faders together over their times, waits, then runs an action; the key is lit while it runs', async () => {
    vi.useFakeTimers();
    let state: ConsoleState = { ...defaultState(), channels: defaultState().channels.map((c) => (c.id === 'ch1' || c.id === 'ch7' ? { ...c, faderDb: -30 } : c)) };
    const host = { get: () => state, set: (p: Partial<ConsoleState>) => (state = { ...state, ...p }) };
    const macro: Macro = {
      id: 'm1',
      name: 'Walk-in',
      color: '#fff',
      steps: [
        { kind: 'fade', target: { kind: 'channel', id: 'ch1' }, db: 0, sec: 2 },
        { kind: 'fade', target: { kind: 'channel', id: 'ch7' }, db: -90, sec: 4 },
        { kind: 'wait', sec: 1 },
        { kind: 'action', call: { type: 'muteGroup.set', args: { id: 'mg2', on: true } } },
      ],
    };
    const done = runMacro(host, macro);
    expect(state.macrosRunning).toContain('m1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fader(state, 'ch1')).toBeGreaterThan(-30); // both moving at once
    expect(fader(state, 'ch7')).toBeLessThan(-30);
    await vi.advanceTimersByTimeAsync(200);
    expect(state.muteGroups.find((g) => g.id === 'mg2')!.active).toBe(true); // after the 1 s wait
    await vi.advanceTimersByTimeAsync(1100);
    expect(fader(state, 'ch1')).toBe(0); // 2 s move finished
    // grab ch7 by hand: the macro lets go of it
    state = { ...state, channels: state.channels.map((c) => (c.id === 'ch7' ? { ...c, faderDb: -12 } : c)) };
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(fader(state, 'ch7')).toBe(-12);
    expect(state.macrosRunning).not.toContain('m1');
  });
});

describe('user keys with fades', () => {
  it('a key with timed fader sets and a wait becomes a sequence; untimed keys stay instant', () => {
    expect(timedSteps([{ type: 'channel.fader.set', args: { id: 'ch1', db: 0, sec: 0 } }])).toBeNull();
    const steps = timedSteps([
      { type: 'channel.fader.set', args: { id: 'ch7', db: -90, sec: 4 } },
      { type: 'dca.fader.set', args: { id: 'dca1', db: -5, sec: 2 } },
      { type: 'wait', args: { sec: 1 } },
      { type: 'muteGroup.set', args: { id: 'mg2', on: true } },
    ])!;
    expect(steps.map((x) => x.kind)).toEqual(['fade', 'fade', 'wait', 'action']);
    expect(steps[1]).toMatchObject({ target: { kind: 'dca', id: 'dca1' }, db: -5, sec: 2 });
  });
  it('pressing such a key fades the fader in the live store and lights the key until done', async () => {
    vi.useFakeTimers();
    const { useConsole } = await import('./store');
    const st = useConsole.getState();
    st.update((s) => ({
      channels: s.channels.map((c) => (c.id === 'ch1' ? { ...c, faderDb: -30 } : c)),
      userKeys: [{ id: 'ukT', label: 'Fade', color: '#fff', mode: 'latch', actions: [{ type: 'channel.fader.set', args: { id: 'ch1', db: 0, sec: 2 } }] }, ...s.userKeys],
    }));
    useConsole.getState().pressKey('ukT');
    await vi.advanceTimersByTimeAsync(1000);
    const mid = useConsole.getState().channels[0].faderDb;
    expect(mid).toBeGreaterThan(-30);
    expect(mid).toBeLessThan(0);
    expect(useConsole.getState().macrosRunning).toContain('ukT');
    useConsole.getState().releaseKey('ukT');
    await vi.advanceTimersByTimeAsync(1200);
    expect(useConsole.getState().channels[0].faderDb).toBe(0);
    expect(useConsole.getState().macrosRunning).not.toContain('ukT');
  });
});
