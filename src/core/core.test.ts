import { describe, expect, it } from 'vitest';
import { keyIsOn, runAction, runActions } from './actions';
import { defaultState } from './defaults';
import {
  channelEffectiveFaderDb,
  channelMuteReason,
  computeChannelGains,
  dbToGain,
  faderDbToPos,
  faderPosToDb,
} from './mix';
import { applyScene, takeSnapshot } from './scenes';
import { parseShow, serializeShow } from './store';

describe('fader taper', () => {
  it('round-trips', () => {
    for (const db of [-60, -30, -10, -5, 0, 3, 10]) expect(faderPosToDb(faderDbToPos(db))).toBeCloseTo(db, 6);
  });
  it('unity at 75%', () => expect(faderPosToDb(0.75)).toBe(0));
  it('bottom is -inf', () => expect(faderPosToDb(0)).toBe(-Infinity));
});

describe('mute groups and DCAs', () => {
  it('mute group mutes members only', () => {
    let s = defaultState();
    s = runAction(s, { type: 'muteGroup.toggle', args: { id: 'mg1' } });
    const host = s.channels.find((c) => c.id === 'ch1')!;
    const remote = s.channels.find((c) => c.id === 'ch4')!;
    expect(channelMuteReason(s, host)).toMatchObject({ muted: true, self: false, groups: ['mg1'] });
    expect(channelMuteReason(s, remote).muted).toBe(false);
    expect(computeChannelGains(s, host).main).toBe(0);
    // the channel's own mute is untouched
    expect(host.mute).toBe(false);
  });

  it('DCA offsets add to channel fader', () => {
    let s = defaultState();
    s = runAction(s, { type: 'dca.fader.set', args: { id: 'dca1', db: -10 } });
    const host = s.channels.find((c) => c.id === 'ch1')!;
    expect(channelEffectiveFaderDb(s, host)).toBeCloseTo(-22);
  });

  it('DCA mute mutes members', () => {
    const s = runAction(defaultState(), { type: 'dca.mute.toggle', args: { id: 'dca1' } });
    expect(channelMuteReason(s, s.channels[0]).dcas).toEqual(['dca1']);
  });
});

describe('mix-minus', () => {
  it('excludes the remote guest from their own feed', () => {
    const s = defaultState();
    const remote = s.channels.find((c) => c.id === 'ch4')!;
    const host = s.channels.find((c) => c.id === 'ch1')!;
    expect(computeChannelGains(s, remote).sends['bus7'].gain).toBe(0);
    expect(computeChannelGains(s, host).sends['bus7'].gain).toBeCloseTo(dbToGain(-12));
  });
});

describe('keys', () => {
  it('LED follows real state', () => {
    let s = defaultState();
    const key = s.userKeys[0];
    expect(keyIsOn(s, key.actions)).toBe(false);
    s = runAction(s, { type: 'muteGroup.set', args: { id: 'mg1', on: true } });
    expect(keyIsOn(s, key.actions)).toBe(true);
  });
});

describe('scenes', () => {
  it('recall respects recall safe and scope', () => {
    let s = defaultState();
    s = runAction(s, { type: 'scene.store', args: {} });
    const scene = s.scenes[0];
    s = { ...s, channels: s.channels.map((c) => ({ ...c, faderDb: -30 })) };
    s.channels[1] = { ...s.channels[1], recallSafe: true };
    s = applyScene(s, scene);
    expect(s.channels[0].faderDb).toBe(-12);
    expect(s.channels[1].faderDb).toBe(-30);
    s = { ...s, sceneScope: { ...s.sceneScope, channels: false }, channels: s.channels.map((c) => ({ ...c, faderDb: -40 })) };
    s = applyScene(s, scene);
    expect(s.channels[0].faderDb).toBe(-40);
  });

  it('next/prev steps through the list', () => {
    let s = defaultState();
    s = runActions(s, [{ type: 'scene.store', args: {} }, { type: 'scene.store', args: {} }]);
    s = runAction(s, { type: 'scene.prev', args: {} });
    expect(s.currentScene).toBe(s.scenes[0].id);
    s = runAction(s, { type: 'scene.next', args: {} });
    expect(s.currentScene).toBe(s.scenes[1].id);
    expect(takeSnapshot(s).channels.length).toBe(32);
  });
});

describe('show files', () => {
  it('round-trip keeps -inf faders', () => {
    const s = defaultState();
    const back = parseShow(serializeShow(s));
    expect(back.channels[10].faderDb).toBe(-Infinity);
    expect(back.channels[0].faderDb).toBe(-12);
  });
});
