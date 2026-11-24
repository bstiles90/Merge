import { describe, expect, it } from 'vitest';
import { defaultState } from './defaults';
import { buildMixPlan } from './plan';
import { runAction } from './actions';
import {
  applySuggestedRoles,
  contextFromProPresenter,
  decideMoment,
  fireMoment,
  noteTag,
  suggestRole,
  textMatches,
  undoMoment,
  type Role,
} from './moments';
import type { ConsoleState } from './types';

function show(roles: [string, Role][]): ConsoleState {
  const s = defaultState();
  return {
    ...s,
    channels: s.channels.map((c, i) => (i < roles.length ? { ...c, name: roles[i][0], role: roles[i][1], mute: false, faderDb: -5, recallSafe: false } : { ...c, role: undefined })),
  };
}
const ch = (s: ConsoleState, i: number) => s.channels[i];

describe('roles', () => {
  it('suggests roles from typical channel names', () => {
    expect(suggestRole('Pastor HH')).toBe('speaker');
    expect(suggestRole('Kick In')).toBe('band');
    expect(suggestRole('BV 2')).toBe('bvs');
    expect(suggestRole('WL Vox')).toBe('leadVocal');
    expect(suggestRole('Tracks L')).toBe('playback');
    expect(suggestRole('Aud L')).toBe('audience');
    expect(suggestRole('Keys L')).toBe('keys');
    expect(suggestRole('Ch 17')).toBeUndefined();
  });
  it('only fills channels without a role', () => {
    const s = show([['Pastor', 'band']]);
    s.channels[1] = { ...s.channels[1], name: 'Snare' };
    const r = applySuggestedRoles(s);
    expect(ch(r.state, 0).role).toBe('band');
    expect(ch(r.state, 1).role).toBe('band');
  });
});

describe('moments', () => {
  const base = () => show([['Pastor', 'speaker'], ['Lead', 'leadVocal'], ['Kick', 'band'], ['Tracks', 'playback']]);

  it('Sermon opens the speaker and closes the band, vocals and playback', () => {
    const r = fireMoment(base(), 'speech');
    const s = r.state;
    expect(ch(s, 0).mute).toBe(false);
    expect([1, 2, 3].map((i) => ch(s, i).mute)).toEqual([true, true, true]);
    expect(s.automation.current).toBe('speech');
    expect(r.opened).toEqual(['ch1']);
  });

  it('learns levels and recalls them next time', () => {
    let s = fireMoment(base(), 'speech').state;
    s = { ...s, channels: s.channels.map((c) => (c.id === 'ch1' ? { ...c, faderDb: -2 } : c)) }; // operator rides the pastor
    s = fireMoment(s, 'song').state; // leaving speech learns -2
    expect(s.automation.learned.speech.ch1).toBe(-2);
    s = { ...s, channels: s.channels.map((c) => (c.id === 'ch1' ? { ...c, faderDb: -30 } : c)) };
    s = fireMoment(s, 'speech').state;
    expect(ch(s, 0).faderDb).toBe(-2);
  });

  it('holds a channel whose mute was changed by hand since the last moment', () => {
    let s = fireMoment(base(), 'song').state; // pastor closed
    s = { ...s, channels: s.channels.map((c) => (c.id === 'ch1' ? { ...c, mute: false } : c)) }; // opened by hand
    const r = fireMoment(s, 'video'); // video would close the pastor
    expect(r.held).toContain('ch1');
    expect(ch(r.state, 0).mute).toBe(false);
    // held once only: the next moment applies again
    const r2 = fireMoment(r.state, 'song');
    expect(r2.held).not.toContain('ch1');
    expect(ch(r2.state, 0).mute).toBe(true);
  });

  it('never touches recall-safe channels', () => {
    const s0 = base();
    s0.channels[2] = { ...s0.channels[2], recallSafe: true };
    const s = fireMoment(s0, 'speech').state;
    expect(ch(s, 2).mute).toBe(false);
  });

  it('a section moment starts from the song levels plus its trim', () => {
    let s = show([['BV', 'bvs'], ['Kick', 'band']]);
    s = fireMoment(s, 'song').state;
    s = { ...s, channels: s.channels.map((c) => (c.id === 'ch1' ? { ...c, faderDb: -8 } : c)) };
    s = fireMoment(s, 'speech').state; // learns song: BV -8
    s = fireMoment(s, 'chorus').state; // chorus has no levels yet: song + 2 dB on BVs
    expect(ch(s, 0).faderDb).toBe(-6);
  });

  it('undo puts back exactly what the moment changed', () => {
    const s0 = base();
    const s1 = fireMoment(s0, 'speech').state;
    const s2 = undoMoment(s1);
    expect(s2.channels.map((c) => c.mute).slice(0, 4)).toEqual(s0.channels.map((c) => c.mute).slice(0, 4));
    expect(s2.automation.current).toBe(null);
  });

  it('sends a fade with the plan for the changed channels only, and only for a while', () => {
    const t = 1_000_000;
    const s = fireMoment(base(), 'speech', t).state;
    const plan = buildMixPlan(s, t + 100) as any;
    expect(plan.channels[0].fadeMs).toBe(2000);
    expect(plan.channels[0].fadeId).toBe(s.automation.fade!.id);
    expect(plan.channels[10].fadeId).toBeUndefined();
    const later = buildMixPlan(s, t + 60_000) as any;
    expect(later.channels[0].fadeId).toBeUndefined();
  });

  it('is available as an action (user keys, Stream Deck) with an LED', () => {
    const s = runAction(base(), { type: 'moment.fire', args: { moment: 'video' } });
    expect(s.automation.current).toBe('video');
    expect(s.automation.lastEvent?.text).toMatch(/^Video/);
  });
});

describe('ProPresenter rules', () => {
  const raw = (item: string, groups: [string, number][], index: number, notes: Record<number, string> = {}) => {
    let k = 0;
    return {
      'presentation/active': {
        presentation: {
          id: { uuid: 'P1', name: 'Way Maker', index: 0 },
          groups: groups.map(([name, n]) => ({ name, slides: Array.from({ length: n }, () => ({ text: '', notes: notes[k++] ?? '' })) })),
        },
      },
      'presentation/slide_index': { presentation_index: { index, presentation_id: { uuid: 'P1', name: 'Way Maker', index: 0 } } },
      'playlist/active': { presentation: { playlist: { uuid: 'L', name: 'Sunday', index: 0 }, item: { uuid: 'I', name: item, index: 3 } } },
      'status/layers': { media: false, video_input: false, slide: true, announcements: false, props: false, messages: false, audio: false },
    };
  };
  const a = defaultState().automation;

  it('finds the slide group from the slide index', () => {
    const c = contextFromProPresenter(raw('Way Maker', [['Verse 1', 2], ['Chorus', 3]], 3));
    expect(c.group).toBe('Chorus');
    expect(c.isSong).toBe(true);
    expect(c.item).toBe('Way Maker');
  });

  it('a song → Song; the sermon item → Speech', () => {
    expect(decideMoment(contextFromProPresenter(raw('Way Maker', [['Verse 1', 2], ['Chorus', 2]], 0)), a)?.moment.id).toBe('song');
    expect(decideMoment(contextFromProPresenter(raw('Sunday Sermon', [['Point 1', 4]], 1)), a)?.moment.id).toBe('speech');
  });

  it('section rules only when switched on', () => {
    const ctx = contextFromProPresenter(raw('Way Maker', [['Verse 1', 2], ['Chorus', 2]], 2));
    expect(decideMoment(ctx, a)?.moment.id).toBe('song');
    const on = {
      moments: a.moments.map((m) => (m.id === 'chorus' ? { ...m, enabled: true } : m)),
      rules: a.rules.map((r) => (r.moment === 'chorus' ? { ...r, enabled: true } : r)),
    };
    expect(decideMoment(ctx, on)?.moment.id).toBe('chorus');
  });

  it('a slide note tag beats the rules', () => {
    const ctx = contextFromProPresenter(raw('Way Maker', [['Verse 1', 2]], 1, { 1: 'merge: Video' }));
    const d = decideMoment(ctx, a);
    expect(d?.moment.id).toBe('video');
    expect(d?.why).toMatch(/slide note/);
    expect(noteTag('Merge:sermon', a.moments)?.id).toBe('speech');
  });

  it('a song whose title contains a rule word is still a song', () => {
    expect(decideMoment(contextFromProPresenter(raw('Welcome Holy Spirit', [['Verse 1', 2], ['Chorus', 2]], 0)), a)?.moment.id).toBe('song');
    expect(decideMoment(contextFromProPresenter(raw('Welcome', [['Slides', 3]], 0)), a)?.moment.id).toBe('host');
    expect(decideMoment(contextFromProPresenter(raw('Message', [['Intro', 1], ['Point 1', 3]], 0)), a)?.moment.id).toBe('speech');
  });

  it('a real service order (playlist from our church)', () => {
    const item = (name: string, groups: [string, number][] = [['Slides', 2]]) => decideMoment(contextFromProPresenter(raw(name, groups, 0)), a)?.moment.id;
    const song: [string, number][] = [['Intro', 1], ['Verse 1', 2], ['Chorus 1', 2], ['Turnaround', 1], ['Refrain', 1], ['Bridge', 2], ['Ending', 1]];
    expect(item('Announcement Loop')).toBe('walk');
    expect(item('Prelude')).toBe('walk'); // house music first...
    // ...then the ProPresenter operator clicks the Prelude's "Band" slide (notes: merge: Song)
    expect(decideMoment(contextFromProPresenter(raw('Prelude', [['House Music', 1], ['Band', 1]], 1, { 1: 'merge: Song' })), a)?.moment.id).toBe('song');
    expect(item('Welcome')).toBe('host');
    expect(item('Here I Am To Worship', song)).toBe('song');
    expect(item('Prayer + Giving Moment')).toBe('prayer');
    expect(item('Message')).toBe('speech');
    expect(item('Forever YHWH', song)).toBe('song');
    expect(item('Communion')).toBe('prayer');
  });

  it('nothing recognisable → no change', () => {
    expect(decideMoment(contextFromProPresenter(raw('Countdown', [['Group', 1]], 0)), a)).toBeUndefined();
  });

  it('matching: contains, or * wildcards', () => {
    expect(textMatches('Sunday Sermon', 'sermon')).toBe(true);
    expect(textMatches('Walk-in Music', 'Walk*')).toBe(true);
    expect(textMatches('Sidewalk', 'Walk*')).toBe(false);
  });
});
