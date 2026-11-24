import { describe, expect, it } from 'vitest';
import { runAction } from './actions';
import { defaultState } from './defaults';
import { createLink, linkInfo, naturalPartner, removeLink, setLinkOption, syncLinks } from './links';
import { useConsole } from './store';
import type { ConsoleState } from './types';

const ch = (s: ConsoleState, id: string) => s.channels.find((c) => c.id === id)!;
const linked = () => {
  const s = defaultState();
  return { ...s, ...createLink({ ...s, stereoLinks: [] }, 'ch1', 'ch2') } as ConsoleState;
};

describe('stereo links', () => {
  it('pairs odd channels with the next one', () => {
    expect(naturalPartner('ch1')).toBe('ch2');
    expect(naturalPartner('ch8')).toBe('ch7');
  });

  it('creating a link pans hard L/R and copies linked settings from the left', () => {
    const s = linked();
    expect(ch(s, 'ch1').pan).toBe(-1);
    expect(ch(s, 'ch2').pan).toBe(1);
    expect(linkInfo(s, 'ch2')).toMatchObject({ partner: 'ch1', side: 'R' });
  });

  it('fader, mute and sends follow; pan and inserts stay independent', () => {
    const prev = linked();
    const next = {
      ...prev,
      channels: prev.channels.map((c) =>
        c.id === 'ch2' ? { ...c, faderDb: -3, mute: true, pan: 0.2, sends: { bus3: { on: true, levelDb: -6, pre: false } } } : c,
      ),
    };
    const out = { ...next, channels: syncLinks(prev, next) };
    expect(ch(out, 'ch1').faderDb).toBe(-3);
    expect(ch(out, 'ch1').mute).toBe(true);
    expect(ch(out, 'ch1').sends.bus3?.levelDb).toBe(-6);
    expect(ch(out, 'ch1').pan).toBe(-1);
  });

  it('processing can be unlinked for separate L/R EQ', () => {
    let s = linked();
    s = { ...s, ...setLinkOption(s, 'ch1', 'processing', false) } as ConsoleState;
    const next = { ...s, channels: s.channels.map((c) => (c.id === 'ch1' ? { ...c, hpf: { on: true, freq: 200 } } : c)) };
    expect(ch({ ...next, channels: syncLinks(s, next) } as ConsoleState, 'ch2').hpf.freq).not.toBe(200);
  });

  it('works through the store: actions, user keys and fader moves all follow the link', () => {
    const st = useConsole.getState();
    st.loadShow(linked());
    useConsole.getState().dispatch({ type: 'channel.mute.toggle', args: { id: 'ch1' } });
    expect(ch(useConsole.getState(), 'ch2').mute).toBe(true);
    useConsole.getState().updateChannel('ch2', { faderDb: -7 });
    expect(ch(useConsole.getState(), 'ch1').faderDb).toBe(-7);
    useConsole.getState().update((x) => removeLink(x, 'ch1'));
    useConsole.getState().updateChannel('ch2', { faderDb: -20 });
    expect(ch(useConsole.getState(), 'ch1').faderDb).toBe(-7);
  });

  it('solo follows the link', () => {
    const s = runAction(linked(), { type: 'channel.solo.toggle', args: { id: 'ch1' } });
    expect(ch({ ...s, channels: syncLinks(linked(), s) } as ConsoleState, 'ch2').solo).toBe(true);
  });
});
