// Show moments: service automation without anyone building scenes.
//
// Every channel has a *role* (speaker, lead vocal, band…). A *moment* (Song, Sermon,
// Video…) opens some roles and closes others. Levels aren't programmed: Merge *learns*
// where each channel sat the last time that moment happened, and recalls it next time.
// Moments fire by hand (GO / moment buttons / user keys) or from ProPresenter rules.
//
// Safety: only when armed (for automatic triggers); a mute changed by hand since the last
// moment is held once; recall-safe channels are never touched; one-step undo.

import type { Channel, ConsoleState } from './types';

export type Role = 'speaker' | 'host' | 'leadVocal' | 'bvs' | 'band' | 'keys' | 'playback' | 'audience';

export const ROLES: { id: Role; label: string; hint: string }[] = [
  { id: 'speaker', label: 'Speaker / Pastor', hint: 'Sermon mics' },
  { id: 'host', label: 'Host', hint: 'Announcements, welcome, MC' },
  { id: 'leadVocal', label: 'Lead vocal', hint: 'Worship leader' },
  { id: 'bvs', label: 'BVs / Choir', hint: 'Backing vocals' },
  { id: 'band', label: 'Band', hint: 'Drums, bass, guitars…' },
  { id: 'keys', label: 'Keys / Pad', hint: 'Stays up under prayer' },
  { id: 'playback', label: 'Playback / Video', hint: 'Tracks, video, walk-in music' },
  { id: 'audience', label: 'Audience mics', hint: 'Room / congregation' },
];

export const roleLabel = (r?: Role) => ROLES.find((x) => x.id === r)?.label ?? 'No role';

/** Guess a role from a channel name ("Pastor HH" → speaker). Undefined when unsure. */
export function suggestRole(name: string): Role | undefined {
  const n = name.toLowerCase();
  const has = (...w: string[]) => w.some((x) => new RegExp(`(^|[^a-z])${x}`).test(n));
  if (has('pastor', 'preach', 'sermon', 'speaker', 'pulpit', 'lectern', 'teach')) return 'speaker';
  if (has('host', 'mc', 'announce', 'emcee', 'wireless', 'hh', 'handheld', 'lav')) return 'host';
  if (has('aud', 'crowd', 'room', 'amb', 'congreg', 'house')) return 'audience';
  if (has('track', 'playback', 'video', 'vid', 'pb', 'click', 'walk', 'music bed', 'spotify', 'pc', 'mac', 'propres', 'pro7', 'media')) return 'playback';
  if (has('bv', 'bgv', 'back', 'choir', 'harm', 'alto', 'tenor', 'sop')) return 'bvs';
  if (has('lead', 'wl', 'worship')) return 'leadVocal';
  if (has('vox', 'vocal', 'voc', 'vx', 'sing')) return 'bvs';
  if (has('key', 'piano', 'pno', 'organ', 'synth', 'pad', 'rhodes', 'nord', 'b3')) return 'keys';
  if (has('kick', 'kik', 'snare', 'snr', 'tom', 'hat', 'hh', 'oh', 'over', 'ride', 'drum', 'bass', 'gtr', 'guitar', 'eg', 'ag', 'acou', 'elec', 'perc', 'cajon', 'bgtr', 'violin', 'cello', 'horn', 'sax', 'trumpet'))
    return 'band';
  return undefined;
}

export interface Moment {
  id: string;
  name: string;
  /** roles opened (unmuted, at their learned level) */
  open: Role[];
  /** roles closed (muted) */
  close: Role[];
  /** dB offsets on top of the inherited moment's learned levels, before this moment has its own */
  trims?: Partial<Record<Role, number>>;
  /** a section moment (Chorus) starts from another moment's (Song) learned levels */
  inherits?: string;
  fadeMs: number;
  enabled: boolean;
}

const ALL: Role[] = ['speaker', 'host', 'leadVocal', 'bvs', 'band', 'keys', 'playback', 'audience'];
const except = (...r: Role[]) => ALL.filter((x) => !r.includes(x));

export const DEFAULT_MOMENTS: Moment[] = [
  { id: 'song', name: 'Song', open: ['leadVocal', 'bvs', 'band', 'keys', 'audience'], close: ['speaker', 'host', 'playback'], fadeMs: 1500, enabled: true },
  { id: 'chorus', name: 'Chorus', open: ['leadVocal', 'bvs', 'band', 'keys', 'audience'], close: ['speaker', 'host', 'playback'], inherits: 'song', trims: { bvs: 2 }, fadeMs: 800, enabled: false },
  { id: 'bridge', name: 'Bridge / Tag', open: ['leadVocal', 'bvs', 'band', 'keys', 'audience'], close: ['speaker', 'host', 'playback'], inherits: 'song', trims: {}, fadeMs: 800, enabled: false },
  { id: 'speech', name: 'Sermon / Speech', open: ['speaker'], close: except('speaker'), fadeMs: 2000, enabled: true },
  { id: 'prayer', name: 'Prayer', open: ['speaker', 'keys'], close: ['leadVocal', 'bvs', 'band', 'playback', 'audience', 'host'], inherits: 'speech', fadeMs: 2500, enabled: true },
  { id: 'video', name: 'Video / Playback', open: ['playback'], close: except('playback'), fadeMs: 1000, enabled: true },
  { id: 'host', name: 'Announcements / Host', open: ['host'], close: except('host'), fadeMs: 1500, enabled: true },
  { id: 'walk', name: 'Walk-in / Walk-out', open: ['playback'], close: except('playback'), fadeMs: 3000, enabled: true },
];

export type RuleField = 'item' | 'presentation' | 'group' | 'song' | 'media';
export interface Rule {
  id: string;
  /** item = playlist item name; presentation = presentation name; group = slide group (Chorus…);
   *  song = "the presentation has song groups" (Verse/Chorus/Bridge); media = a media cue is live */
  field: RuleField;
  /** text to look for (case-insensitive; contains, or a pattern with * wildcards) */
  match: string;
  moment: string;
  enabled: boolean;
}

/** Checked top to bottom; the first match wins. Slide notes `merge: <moment>` beat every rule.
 *  Songs (recognised by their slide groups) come before the playlist-item name rules, so a song
 *  titled "Welcome Holy Spirit" or "Message of the Cross" is still a song. */
export const DEFAULT_RULES: Rule[] = [
  { id: 'r9', field: 'group', match: 'Chorus', moment: 'chorus', enabled: false },
  { id: 'r10', field: 'group', match: 'Bridge', moment: 'bridge', enabled: false },
  { id: 'r11', field: 'group', match: 'Tag', moment: 'bridge', enabled: false },
  { id: 'r12', field: 'song', match: '', moment: 'song', enabled: true },
  { id: 'r1', field: 'item', match: 'Message', moment: 'speech', enabled: true },
  { id: 'r2', field: 'item', match: 'Sermon', moment: 'speech', enabled: true },
  { id: 'r3', field: 'item', match: 'Prayer', moment: 'prayer', enabled: true },
  { id: 'r13', field: 'item', match: 'Communion', moment: 'prayer', enabled: true },
  { id: 'r14', field: 'item', match: 'Loop', moment: 'walk', enabled: true },
  { id: 'r5', field: 'item', match: 'Welcome', moment: 'host', enabled: true },
  { id: 'r4', field: 'item', match: 'Announcement', moment: 'host', enabled: true },
  { id: 'r6', field: 'item', match: 'Video', moment: 'video', enabled: true },
  { id: 'r7', field: 'item', match: 'Walk*', moment: 'walk', enabled: true },
  { id: 'r8', field: 'media', match: '', moment: 'video', enabled: false },
];

export interface ChannelMix {
  mute: boolean;
  faderDb: number;
}

export interface Automation {
  /** automatic triggers (ProPresenter) only fire when armed; buttons and GO always work */
  armed: boolean;
  moments: Moment[];
  rules: Rule[];
  /** learned fader level per moment per channel (dB) */
  learned: Record<string, Record<string, number>>;
  current: string | null;
  /** what the last moment set, to notice changes made by hand */
  lastApplied: Record<string, ChannelMix>;
  /** state before the last moment, for one-step undo */
  undo: { moment: string | null; channels: Record<string, ChannelMix> } | null;
  /** the fade the engine should run (sent with the mix plan for a short while) */
  fade: { id: number; ms: number; at: number; channels: string[] } | null;
  propresenter: { enabled: boolean; host: string; port: number };
  /** last thing automation did, for the show log */
  lastEvent?: { at: number; moment: string; text: string };
}

export function defaultAutomation(): Automation {
  return {
    armed: false,
    moments: DEFAULT_MOMENTS.map((m) => ({ ...m })),
    rules: DEFAULT_RULES.map((r) => ({ ...r })),
    learned: {},
    current: null,
    lastApplied: {},
    undo: null,
    fade: null,
    propresenter: { enabled: false, host: '127.0.0.1', port: 50001 },
  };
}

/** Older shows: fill in automation fields added since. */
export function mergeAutomation(a: Partial<Automation> | undefined): Automation {
  const d = defaultAutomation();
  if (!a) return d;
  const moments = [...(a.moments ?? [])];
  for (const m of d.moments) if (!moments.some((x) => x.id === m.id)) moments.push(m);
  return { ...d, ...a, moments, rules: a.rules ?? d.rules, propresenter: { ...d.propresenter, ...a.propresenter } };
}

const FALLBACK_OPEN_DB = -10;

/** Where a channel opens in this moment: learned → inherited (+ trim) → its current fader. */
export function levelFor(a: Automation, momentId: string, ch: Channel, depth = 0): { db: number; source: 'learned' | 'inherited' | 'current' } {
  const learned = a.learned[momentId]?.[ch.id];
  if (learned !== undefined && isFinite(learned)) return { db: learned, source: 'learned' };
  const m = a.moments.find((x) => x.id === momentId);
  if (m?.inherits && depth < 4) {
    const base = levelFor(a, m.inherits, ch, depth + 1);
    if (base.source !== 'current') {
      const trim = (ch.role && m.trims?.[ch.role]) || 0;
      return { db: Math.min(10, base.db + trim), source: 'inherited' };
    }
  }
  return { db: isFinite(ch.faderDb) ? ch.faderDb : FALLBACK_OPEN_DB, source: 'current' };
}

export interface MomentResult {
  state: ConsoleState;
  opened: string[];
  closed: string[];
  held: string[];
  noRole: number;
}

let fadeCounter = Math.floor(Date.now() / 1000) % 1_000_000;

/** Fire a moment: learn the outgoing moment's levels, then open/close channels by role. */
export function fireMoment(s: ConsoleState, momentId: string, now = Date.now()): MomentResult {
  const a = s.automation;
  const m = a.moments.find((x) => x.id === momentId);
  if (!m) return { state: s, opened: [], closed: [], held: [], noRole: 0 };

  // 1. learn: the outgoing moment's open channels, as they are now (including hand moves)
  const learned = { ...a.learned };
  if (a.current) {
    const prev = { ...(learned[a.current] ?? {}) };
    for (const ch of s.channels) if (!ch.mute && isFinite(ch.faderDb) && ch.role) prev[ch.id] = ch.faderDb;
    learned[a.current] = prev;
  }
  const withLearned: Automation = { ...a, learned };

  // 2. apply by role
  const opened: string[] = [], closed: string[] = [], held: string[] = [];
  const undo: Record<string, ChannelMix> = {};
  const lastApplied = { ...a.lastApplied };
  let noRole = 0;
  const channels = s.channels.map((ch) => {
    if (!ch.role) {
      noRole++;
      return ch;
    }
    const opens = m.open.includes(ch.role), closes = m.close.includes(ch.role);
    if ((!opens && !closes) || ch.recallSafe) return ch;
    const last = a.lastApplied[ch.id];
    if (last && last.mute !== ch.mute) {
      // changed by hand since the last moment: leave it this time
      held.push(ch.id);
      lastApplied[ch.id] = { mute: ch.mute, faderDb: ch.faderDb };
      return ch;
    }
    undo[ch.id] = { mute: ch.mute, faderDb: ch.faderDb };
    let next: Channel;
    if (opens) {
      next = { ...ch, mute: false, faderDb: levelFor(withLearned, m.id, ch).db };
      opened.push(ch.id);
    } else {
      next = { ...ch, mute: true };
      closed.push(ch.id);
    }
    lastApplied[ch.id] = { mute: next.mute, faderDb: next.faderDb };
    return next;
  });

  const changed = [...opened, ...closed];
  const state: ConsoleState = {
    ...s,
    channels,
    automation: {
      ...withLearned,
      current: m.id,
      lastApplied,
      undo: { moment: a.current, channels: undo },
      fade: changed.length ? { id: ++fadeCounter, ms: m.fadeMs, at: now, channels: changed } : a.fade,
    },
  };
  return { state, opened, closed, held, noRole };
}

/** Put back what the last moment changed. */
export function undoMoment(s: ConsoleState, now = Date.now()): ConsoleState {
  const a = s.automation;
  if (!a.undo) return s;
  const u = a.undo.channels;
  const lastApplied = { ...a.lastApplied };
  const channels = s.channels.map((ch) => {
    const was = u[ch.id];
    if (!was) return ch;
    lastApplied[ch.id] = was;
    return { ...ch, mute: was.mute, faderDb: was.faderDb };
  });
  return {
    ...s,
    channels,
    automation: { ...a, current: a.undo.moment, undo: null, lastApplied, fade: { id: ++fadeCounter, ms: 500, at: now, channels: Object.keys(u) } },
  };
}

/** Give every channel without a role the suggested one (from its name). */
export function applySuggestedRoles(s: ConsoleState): { state: ConsoleState; count: number } {
  let count = 0;
  const channels = s.channels.map((ch) => {
    if (ch.role) return ch;
    const r = suggestRole(ch.name);
    if (!r) return ch;
    count++;
    return { ...ch, role: r };
  });
  return { state: { ...s, channels }, count };
}

// ------------------------------------------------------------------ ProPresenter → moment

/** What ProPresenter is showing, boiled down for the rules. */
export interface ShowContext {
  presentation: string;
  item: string;
  playlist: string;
  group: string;
  notes: string;
  /** the presentation has song-style groups (Verse / Chorus / Bridge…) */
  isSong: boolean;
  mediaLive: boolean;
}

export const emptyContext = (): ShowContext => ({ presentation: '', item: '', playlist: '', group: '', notes: '', isSong: false, mediaLive: false });

const SONG_GROUP = /^(verse|chorus|pre[- ]?chorus|bridge|refrain)\b/i;

/** Raw ProPresenter API data (by endpoint) → ShowContext. */
export function contextFromProPresenter(raw: Record<string, any>): ShowContext {
  const c = emptyContext();
  const pres = raw['presentation/active']?.presentation;
  const idx = raw['presentation/slide_index']?.presentation_index;
  const pl = raw['playlist/active']?.presentation;
  const layers = raw['status/layers'];
  if (pres) {
    c.presentation = pres.id?.name ?? '';
    const groups: any[] = Array.isArray(pres.groups) ? pres.groups : [];
    c.isSong = groups.some((g) => SONG_GROUP.test(String(g?.name ?? '').trim()));
    // the slide index counts slides across all groups, in order
    const sameDeck = !idx?.presentation_id?.uuid || !pres.id?.uuid || idx.presentation_id.uuid === pres.id.uuid;
    if (idx && typeof idx.index === 'number' && sameDeck) {
      let n = idx.index;
      for (const g of groups) {
        const slides: any[] = Array.isArray(g?.slides) ? g.slides : [];
        if (n < slides.length) {
          c.group = String(g?.name ?? '');
          c.notes = String(slides[n]?.notes ?? '');
          break;
        }
        n -= slides.length;
      }
    }
  }
  if (!c.presentation && idx?.presentation_id?.name) c.presentation = idx.presentation_id.name;
  if (pl) {
    c.item = pl.item?.name ?? '';
    c.playlist = pl.playlist?.name ?? '';
  }
  if (layers) c.mediaLive = !!layers.media || !!layers.video_input;
  return c;
}

/** Case-insensitive: plain text = "contains"; with * = wildcard over the whole value. */
export function textMatches(value: string, pattern: string): boolean {
  const v = value.trim().toLowerCase(), p = pattern.trim().toLowerCase();
  if (!p) return v.length > 0;
  if (!p.includes('*')) return v.includes(p);
  const re = new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(v);
}

/** A `merge: <moment>` tag in slide notes (matches moment id or name). */
export function noteTag(notes: string, moments: Moment[]): Moment | undefined {
  const m = /merge\s*:\s*([^\n\r;]+)/i.exec(notes);
  if (!m) return undefined;
  const want = m[1].trim().toLowerCase();
  return moments.find((x) => x.id.toLowerCase() === want || x.name.toLowerCase() === want || x.name.toLowerCase().startsWith(want));
}

export interface Decision {
  moment: Moment;
  why: string;
}

/** Which moment the show context calls for (or undefined: leave the mix as it is). */
export function decideMoment(ctx: ShowContext, a: Pick<Automation, 'moments' | 'rules'>): Decision | undefined {
  const usable = (id: string) => a.moments.find((m) => m.id === id && m.enabled);
  const tagged = noteTag(ctx.notes, a.moments);
  if (tagged && tagged.enabled) return { moment: tagged, why: `slide note "merge: ${tagged.name}"` };
  for (const r of a.rules) {
    if (!r.enabled) continue;
    const m = usable(r.moment);
    if (!m) continue;
    let hit = false, what = '';
    if (r.field === 'item') { hit = textMatches(ctx.item, r.match); what = `playlist item "${ctx.item}"`; }
    else if (r.field === 'presentation') { hit = textMatches(ctx.presentation, r.match); what = `presentation "${ctx.presentation}"`; }
    else if (r.field === 'group') { hit = textMatches(ctx.group, r.match); what = `slide group "${ctx.group}"`; }
    else if (r.field === 'song') { hit = ctx.isSong; what = `song "${ctx.presentation}"`; }
    else if (r.field === 'media') { hit = ctx.mediaLive; what = 'media playing'; }
    if (hit) return { moment: m, why: what };
  }
  return undefined;
}
