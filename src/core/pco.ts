// Planning Center Services: who leads each service item ("Person" item notes) and which mic
// each person is on this week (a line per person in a plan note, e.g. "HH1 - Sarah"), so
// show moments open the right person's mic. Pure functions; the engine does the HTTP.

import type { Channel } from './types';

export interface PcoItem {
  title: string;
  /** who leads it (from the item note in the person category) */
  person: string;
  type: string;
}

export interface PcoState {
  serviceTypeId: string;
  serviceTypeName: string;
  planId: string;
  planTitle: string;
  planDates: string;
  /** item note category that names who leads an item */
  personCategory: string;
  items: PcoItem[];
  /** plan note text that lists mics (kept for display) */
  micNote: string;
  /** person → channel id, from the plan note, then edited on the mic screen */
  mics: Record<string, string>;
  loadedAt: number;
}

export const defaultPco = (): PcoState => ({
  serviceTypeId: '',
  serviceTypeName: '',
  planId: '',
  planTitle: '',
  planDates: '',
  personCategory: 'Person',
  items: [],
  micNote: '',
  mics: {},
  loadedAt: 0,
});

// ------------------------------------------------------------------ API paths

export const pcoPaths = {
  serviceTypes: () => '/services/v2/service_types?per_page=100&order=sequence',
  /** the next plans from the start of today (so today's service stays "this week" while it runs) */
  upcomingPlans: (st: string, fromIso: string) => `/services/v2/service_types/${st}/plans?filter=after&after=${encodeURIComponent(fromIso)}&order=sort_date&per_page=5`,
  items: (st: string, plan: string) => `/services/v2/service_types/${st}/plans/${plan}/items?include=item_notes&per_page=100`,
  planNotes: (st: string, plan: string) => `/services/v2/service_types/${st}/plans/${plan}/notes?per_page=100`,
};

export const startOfTodayIso = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

// ------------------------------------------------------------------ JSON:API parsing

export function parseServiceTypes(body: any): { id: string; name: string }[] {
  return (body?.data ?? []).map((d: any) => ({ id: String(d.id), name: String(d.attributes?.name ?? '') }));
}

export function parsePlans(body: any): { id: string; title: string; dates: string }[] {
  return (body?.data ?? []).map((d: any) => ({ id: String(d.id), title: String(d.attributes?.title ?? ''), dates: String(d.attributes?.dates ?? '') }));
}

/** Items in order, each with the content of its note in the person category. */
export function parseItems(body: any, personCategory: string): PcoItem[] {
  const notes = new Map<string, { category: string; content: string }>();
  for (const inc of body?.included ?? []) {
    if (inc.type === 'ItemNote') notes.set(String(inc.id), { category: String(inc.attributes?.category_name ?? ''), content: String(inc.attributes?.content ?? '') });
  }
  const cat = personCategory.trim().toLowerCase();
  return (body?.data ?? [])
    .slice()
    .sort((a: any, b: any) => (a.attributes?.sequence ?? 0) - (b.attributes?.sequence ?? 0))
    .map((d: any) => {
      const ids: string[] = (d.relationships?.item_notes?.data ?? []).map((n: any) => String(n.id));
      const person = ids.map((id) => notes.get(id)).find((n) => n && n.category.trim().toLowerCase() === cat)?.content.trim() ?? '';
      return { title: String(d.attributes?.title ?? ''), person, type: String(d.attributes?.item_type ?? '') };
    });
}

export function parsePlanNotes(body: any): { category: string; content: string }[] {
  return (body?.data ?? []).map((d: any) => ({ category: String(d.attributes?.category_name ?? ''), content: String(d.attributes?.content ?? '') }));
}

// ------------------------------------------------------------------ matching

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** the mic's own name: what the strip was called before Merge added a person to it */
export const micName = (c: Channel) => c.baseName ?? c.name;

/** "HH1", "hh 1", "Handheld 1" style token → the channel whose mic name matches. */
export function channelForMic(token: string, channels: Channel[]): Channel | undefined {
  const t = compact(token);
  if (!t || !/[a-z]/.test(t) || !/\d/.test(t)) return channels.find((c) => compact(micName(c)) === t && t.length > 0);
  return channels.find((c) => compact(micName(c)) === t) ?? channels.find((c) => compact(micName(c)).startsWith(t));
}

/** "HH1 - Sarah", "Sarah: HH1", "Pastor Mike = HS2" (one per line) → person → channel id. */
export function parseMicNote(text: string, channels: Channel[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n|<br\s*\/?>|;/i)) {
    const line = raw.replace(/<[^>]+>/g, '').trim();
    if (!line) continue;
    const parts = line.split(/\s*(?:[-–—:=|]|\bon\b)\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const [a, b] = [parts[0], parts.slice(1).join(' ')];
    const chA = channelForMic(a, channels), chB = channelForMic(b, channels);
    if (chA && !chB) out[b] = chA.id;
    else if (chB && !chA) out[a] = chB.id;
  }
  return out;
}

/** The plan note that lists mics: category or text mentioning mics/production, with mic lines. */
export function findMicNote(notes: { category: string; content: string }[], channels: Channel[]): string {
  const scored = notes
    .map((n) => ({ n, hits: Object.keys(parseMicNote(n.content, channels)).length, named: /mic|production|audio|sound/i.test(n.category) }))
    .filter((x) => x.hits > 0)
    .sort((x, y) => Number(y.named) - Number(x.named) || y.hits - x.hits);
  return scored[0]?.n.content ?? '';
}

const TITLES = new Set(['pastor', 'ps', 'pr', 'rev', 'dr', 'mr', 'mrs', 'ms', 'miss', 'elder', 'deacon', 'and', 'the']);
const nameWords = (s: string) => norm(s).split(' ').filter((w) => w.length >= 2 && !TITLES.has(w));

/** Same person? "Pastor Mike" ~ "Mike Smith" ~ "mike". */
export function samePerson(a: string, b: string): boolean {
  if (!a.trim() || !b.trim()) return false;
  if (norm(a) === norm(b)) return true;
  const wa = nameWords(a), wb = nameWords(b);
  return wa.some((w) => wb.includes(w));
}

/** The plan item ProPresenter is showing (titles are synced from Planning Center). */
export function itemForTitle(items: PcoItem[], title: string): PcoItem | undefined {
  const t = norm(title);
  if (!t) return undefined;
  return items.find((i) => norm(i.title) === t) ?? items.find((i) => norm(i.title).startsWith(t) || t.startsWith(norm(i.title)));
}

/** Channels for the person(s) leading an item ("Sarah & Mike" leads to both). */
export function channelsForPerson(person: string, pco: Pick<PcoState, 'mics'>, channels: Channel[]): string[] {
  if (!person.trim()) return [];
  const people = person.split(/\s*(?:&|\+|,|\band\b|\/)\s*/i).filter(Boolean);
  const ids = new Set<string>();
  for (const p of people) {
    for (const [who, ch] of Object.entries(pco.mics)) if (ch && samePerson(who, p)) ids.add(ch);
    // a strip already labelled with the person ("HH1 · Sarah")
    if (![...ids].length) for (const c of channels) if (c.baseName && samePerson(c.name.slice(c.baseName.length), p)) ids.add(c.id);
  }
  return [...ids];
}

/** Everyone named in Person notes, in service order (for the mic screen). */
export function peopleInPlan(items: PcoItem[]): string[] {
  const seen: string[] = [];
  for (const i of items)
    for (const p of i.person.split(/\s*(?:&|\+|,|\band\b|\/)\s*/i).map((x) => x.trim()).filter(Boolean))
      if (!seen.some((s) => samePerson(s, p))) seen.push(p);
  return seen;
}

/** Label strips "HH1 · Sarah" for this week (remembers the mic name to put back later). */
export function labelChannels(channels: Channel[], mics: Record<string, string>): Channel[] {
  const byCh: Record<string, string[]> = {};
  for (const [who, ch] of Object.entries(mics)) if (ch) (byCh[ch] ??= []).push(who);
  return channels.map((c) => {
    const base = micName(c);
    const who = byCh[c.id];
    if (!who) return c.baseName ? { ...c, name: c.baseName, baseName: undefined } : c;
    return { ...c, baseName: base, name: `${base} · ${who.join(' / ')}` };
  });
}

export const clearLabels = (channels: Channel[]): Channel[] => channels.map((c) => (c.baseName ? { ...c, name: c.baseName, baseName: undefined } : c));
