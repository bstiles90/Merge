import { describe, expect, it } from 'vitest';
import { defaultState } from './defaults';
import { assignMultitrack, takesToClips, trackKey } from './multitrack';
import { buildMixPlan } from './plan';

const named = (names: string[]) => {
  const s = defaultState();
  return { ...s, clips: [], channels: s.channels.map((c, i) => ({ ...c, name: names[i] ?? c.name })) };
};
const file = (name: string, duration = 300) => ({ file: `/mt/${name}`, name: name.replace(/\.\w+$/, ''), duration, channels: 1 });

describe('native virtual soundcheck', () => {
  it('matches file names to channel names however the files are numbered', () => {
    expect(trackKey('01 Kick In.wav')).toBe('kick in');
    expect(trackKey('Ch 12 - Snare_Top')).toBe('snare top');
    expect(trackKey('Lead Vocal')).toBe('lead vocal');
  });

  it('puts a multitrack on the right channels, the rest on free ones, all starting together', () => {
    const s = named(['Kick In', 'Snare Top', 'Bass', 'Lead Vocal']);
    const { clips, unassigned } = assignMultitrack(s, [file('03 Bass.wav'), file('01 Kick In.wav'), file('Room L.wav')], 0);
    const on = (n: string) => clips.find((c) => c.name.includes(n))?.trackId;
    expect(on('Bass')).toBe('ch3');
    expect(on('Kick')).toBe('ch1');
    expect(on('Room')).toBe('ch2'); // first channel with no match and no clip
    expect(clips.every((c) => c.start === 0 && c.file)).toBe(true);
    expect(unassigned).toEqual([]);
  });

  it('reports files when there are more files than channels', () => {
    const s = named([]);
    const files = Array.from({ length: s.channels.length + 2 }, (_, i) => file(`Track ${i}.wav`));
    expect(assignMultitrack(s, files).unassigned.length).toBe(2);
  });

  it('turns a finished recording into clips (one per armed channel, plus PGM)', () => {
    const s = named(['Pastor']);
    const clips = takesToClips(s, [
      { trackId: 'ch1', file: '/rec/01 Pastor.wav', channels: 1, start: 12.5, duration: 60 },
      { trackId: 'pgm', file: '/rec/PGM (Main LR).wav', channels: 2, start: 12.5, duration: 60 },
    ]);
    expect(clips.map((c) => c.name)).toEqual(['Pastor #1', 'PGM #1']);
    expect(clips[0]).toMatchObject({ start: 12.5, duration: 60, file: '/rec/01 Pastor.wav', bufferId: '/rec/01 Pastor.wav' });
  });

  it('the plan gives playback channels their file clips (and live channels none)', () => {
    const s0 = named(['Kick In']);
    const { clips } = assignMultitrack(s0, [file('Kick In.wav', 10)]);
    const s = { ...s0, clips, channels: s0.channels.map((c) => (c.id === 'ch1' ? { ...c, inputMode: 'playback' as const } : c)) };
    const plan = buildMixPlan(s) as any;
    expect(plan.channels[0].clips).toEqual([{ file: '/mt/Kick In.wav', start: 0, offset: 0, duration: 10 }]);
    expect(plan.channels[1].clips).toBeUndefined();
  });
});
