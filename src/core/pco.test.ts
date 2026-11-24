import { describe, expect, it } from 'vitest';
import { defaultState } from './defaults';
import { fireMoment } from './moments';
import { channelForMic, channelsForPerson, clearLabels, findMicNote, itemForTitle, labelChannels, parseItems, parseMicNote, peopleInPlan, samePerson } from './pco';

const chans = () => {
  const s = defaultState();
  const names = ['HH1', 'HH2', 'HS1', 'HS2', 'WL Vox', 'Kick', 'Keys', 'Spotify'];
  const roles = ['host', 'host', 'speaker', 'speaker', 'leadVocal', 'band', 'keys', 'playback'] as const;
  return { ...s, channels: s.channels.map((c, i) => (i < names.length ? { ...c, name: names[i], role: roles[i], mute: true, faderDb: -5 } : { ...c, role: undefined })) };
};

// a trimmed real-shape JSON:API response for /items?include=item_notes
const itemsBody = {
  data: [
    { id: '1', type: 'Item', attributes: { title: 'Welcome', sequence: 2, item_type: 'item' }, relationships: { item_notes: { data: [{ type: 'ItemNote', id: 'n1' }, { type: 'ItemNote', id: 'n2' }] } } },
    { id: '2', type: 'Item', attributes: { title: 'Announcement Loop', sequence: 1, item_type: 'item' }, relationships: { item_notes: { data: [] } } },
    { id: '3', type: 'Item', attributes: { title: 'Prayer + Giving Moment', sequence: 3, item_type: 'item' }, relationships: { item_notes: { data: [{ type: 'ItemNote', id: 'n3' }] } } },
    { id: '4', type: 'Item', attributes: { title: 'Message', sequence: 4, item_type: 'item' }, relationships: { item_notes: { data: [{ type: 'ItemNote', id: 'n4' }] } } },
  ],
  included: [
    { type: 'ItemNote', id: 'n1', attributes: { category_name: 'Person', content: 'Sarah Jones' } },
    { type: 'ItemNote', id: 'n2', attributes: { category_name: 'Lighting', content: 'warm wash' } },
    { type: 'ItemNote', id: 'n3', attributes: { category_name: 'Person', content: 'Pastor Mike' } },
    { type: 'ItemNote', id: 'n4', attributes: { category_name: 'person', content: 'Mike' } },
  ],
};

describe('Planning Center plan', () => {
  it('reads items in order with their Person note (other note categories ignored)', () => {
    const items = parseItems(itemsBody, 'Person');
    expect(items.map((i) => i.title)).toEqual(['Announcement Loop', 'Welcome', 'Prayer + Giving Moment', 'Message']);
    expect(items.map((i) => i.person)).toEqual(['', 'Sarah Jones', 'Pastor Mike', 'Mike']);
    expect(peopleInPlan(items)).toEqual(['Sarah Jones', 'Pastor Mike']);
  });

  it('matches ProPresenter item titles to plan items (titles are synced)', () => {
    const items = parseItems(itemsBody, 'Person');
    expect(itemForTitle(items, 'prayer + giving moment')?.person).toBe('Pastor Mike');
    expect(itemForTitle(items, 'Sermon')).toBeUndefined();
  });

  it('reads a weekly production note: "HH1 - Sarah", "Pastor Mike: HS2", either way round', () => {
    const s = chans();
    const note = 'Mics this week\nHH1 - Sarah\nPastor Mike: HS2\nWL - Jen\nrandom line';
    expect(parseMicNote(note, s.channels)).toEqual({ Sarah: 'ch1', 'Pastor Mike': 'ch4' });
    expect(channelForMic('hh 2', s.channels)?.id).toBe('ch2');
    const picked = findMicNote([{ category: 'Lighting', content: 'haze on' }, { category: 'Production', content: note }], s.channels);
    expect(picked).toBe(note);
  });

  it('same person across spellings', () => {
    expect(samePerson('Pastor Mike', 'Mike Smith')).toBe(true);
    expect(samePerson('Sarah Jones', 'Sarah')).toBe(true);
    expect(samePerson('Pastor Mike', 'Pastor Dave')).toBe(false);
  });

  it('labels strips for the week and puts the mic names back', () => {
    const s = chans();
    const labelled = labelChannels(s.channels, { Sarah: 'ch1', 'Pastor Mike': 'ch4' });
    expect(labelled[0].name).toBe('HH1 · Sarah');
    expect(labelled[3].name).toBe('HS2 · Pastor Mike');
    // matching still works on the mic's own name once labelled
    expect(parseMicNote('HH1 - Jen', labelled)).toEqual({ Jen: 'ch1' });
    expect(clearLabels(labelled)[0].name).toBe('HH1');
    expect(channelsForPerson('Sarah', { mics: {} }, labelled)).toEqual(['ch1']);
  });
});

describe('moments led by a person', () => {
  it('only the leader\'s mic opens among the speaking mics; the band stays under', () => {
    const s = chans();
    const mics = { 'Sarah Jones': 'ch1', 'Pastor Mike': 'ch4' };
    const focus = channelsForPerson('Pastor Mike', { mics }, s.channels);
    expect(focus).toEqual(['ch4']);
    const r = fireMoment(s, 'prayer', Date.now(), focus).state;
    const open = r.channels.slice(0, 8).map((c) => (c.mute ? 0 : 1)).join('');
    //                 HH1 HH2 HS1 HS2 WL Kick Keys Spotify
    expect(open).toBe('0' + '0' + '0' + '1' + '0' + '1' + '1' + '0');
  });

  it('the worship leader can lead a prayer from their vocal mic', () => {
    const s = chans();
    const r = fireMoment(s, 'prayer', Date.now(), ['ch5']).state;
    expect(r.channels[4].mute).toBe(false); // WL Vox opened although Prayer leaves lead vocal alone
    expect(r.channels[2].mute && r.channels[3].mute && r.channels[0].mute).toBe(true);
  });

  it('without a known leader it opens every speaking mic, as before', () => {
    const r = fireMoment(chans(), 'prayer').state;
    expect(r.channels.slice(0, 4).every((c) => !c.mute)).toBe(true);
  });
});
