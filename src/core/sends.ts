// Send tap points: INPUT / PRE (whole rack or after a chosen plugin) / POST / PSP.
import type { Channel, Send, SendTap } from './types';

export const sendTap = (s: Pick<Send, 'tap' | 'pre'>): SendTap => s.tap ?? (s.pre ? 'pre' : 'post');
export const isPreFader = (t: SendTap) => t === 'input' || t === 'pre';

/** How many rack plugins come before a pre tap (undefined = after the whole rack). */
export function tapAfterCount(ch: Pick<Channel, 'inserts'>, s: Pick<Send, 'tap' | 'pre' | 'tapAfter'>): number | undefined {
  if (sendTap(s) !== 'pre' || !s.tapAfter) return undefined;
  const i = ch.inserts.findIndex((x) => x.id === s.tapAfter);
  return i < 0 || i >= ch.inserts.length - 1 ? undefined : i + 1;
}

/** Short code shown beside the send on the strip. */
export function tapCode(ch: Pick<Channel, 'inserts'>, s: Pick<Send, 'tap' | 'pre' | 'tapAfter'>): string {
  const t = sendTap(s);
  if (t === 'pre') {
    const k = tapAfterCount(ch, s);
    return k ? `P${k}` : 'PRE';
  }
  return t === 'input' ? 'IN' : t === 'post' ? 'POST' : 'PSP';
}

/** Change a send's tap (keeps the `pre` flag in step). */
export function withTap(s: Send, tap: SendTap, tapAfter?: string): Send {
  const { tapAfter: _old, ...rest } = s;
  return { ...rest, tap, pre: isPreFader(tap), ...(tap === 'pre' && tapAfter ? { tapAfter } : {}) };
}

/** The tap choices for a channel: value strings for menus, and their labels. */
export function tapChoices(ch: Pick<Channel, 'inserts'>, name: (pluginId: string, fallback?: string) => string): { value: string; label: string; short: string }[] {
  const out = [{ value: 'input', label: 'INPUT: gain only, before every plugin', short: 'INPUT' }];
  ch.inserts.slice(0, -1).forEach((ins, i) => out.push({ value: `pre:${ins.id}`, label: `PRE after slot ${i + 1}: ${name(ins.pluginId, ins.pluginName)}`, short: `PRE after ${i + 1} · ${name(ins.pluginId, ins.pluginName)}` }));
  out.push({ value: 'pre', label: ch.inserts.length ? 'PRE: after the whole rack, before the fader' : 'PRE: before the fader', short: 'PRE' });
  out.push({ value: 'post', label: 'POST: after the fader', short: 'POST' });
  out.push({ value: 'psp', label: 'PSP: after the fader and pan', short: 'PSP (post-pan)' });
  return out;
}

export const tapValue = (s: Send) => (sendTap(s) === 'pre' && s.tapAfter ? `pre:${s.tapAfter}` : sendTap(s));
export function applyTapValue(s: Send, v: string): Send {
  if (v.startsWith('pre:')) return withTap(s, 'pre', v.slice(4));
  return withTap(s, v as SendTap);
}
