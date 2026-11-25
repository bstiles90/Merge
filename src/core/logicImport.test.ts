import { describe, expect, it } from 'vitest';
import { defaultState } from './defaults';
import { logicDb, logicToShow, readLogicProject } from './logicImport';
import { buildMixPlan, busOrder, createsLoop } from './plan';

// A tiny ProjectData in Logic's chunk layout: 24-byte header, then chunks with a 36-byte
// header (tag reversed, strip u32 at 14, slot u32 at 18, body length u64 at 28).
function chunk(tag: string, body: Uint8Array, strip = 0, slot = 0): Uint8Array {
  const h = new Uint8Array(36);
  const v = new DataView(h.buffer);
  for (let i = 0; i < 4; i++) h[i] = tag.split('').reverse().join('').charCodeAt(i);
  v.setUint32(14, strip, true);
  v.setUint32(18, slot, true);
  v.setUint32(28, body.length, true);
  const out = new Uint8Array(36 + body.length);
  out.set(h);
  out.set(body, 36);
  return out;
}
const bytes = (n: number, set: Record<number, number>) => {
  const b = new Uint8Array(n);
  for (const [k, v] of Object.entries(set)) b[Number(k)] = v;
  return b;
};
const strip = (type: number, fader: number, pan: number, out: number, extra: Record<number, number> = {}) =>
  bytes(253, { 4: type, 85: fader, 89: pan, 92: out, 123: 1, ...extra });
function envi(name: string, stripIndex: number) {
  const n = name.length;
  const b = new Uint8Array(160 + n + (n & 1) + 2 + 8);
  b[158] = n;
  for (let i = 0; i < n; i++) b[160 + i] = name.charCodeAt(i);
  b[160 + n + (n & 1)] = stripIndex + 1;
  return b;
}
const cc = (s: string) => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
const XML = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>manufacturer</key><integer>${cc('BLSA')}</integer><key>subtype</key><integer>${cc('Slnc')}</integer><key>type</key><integer>${cc('aufx')}</integer><key>data</key><data>AAAA</data></dict></plist>`;
function plugin(name: string) {
  const b = new Uint8Array(172 + XML.length + 8);
  for (let i = 0; i < name.length; i++) b[120 + i] = name.charCodeAt(i);
  for (let i = 0; i < XML.length; i++) b[172 + i] = XML.charCodeAt(i);
  return b;
}
const send = (slot: number, bus: number, level: number) => bytes(76, { 0: 0x48, 6: slot, 16: 1, 17: level, 20: bus + 4 });

function project(): Uint8Array {
  const parts = [
    new Uint8Array(24),
    chunk('Song', new Uint8Array(8)),
    // strip 0: Kick (mono) -> Bus 4, send to Bus 5; strip 1: Kick Bus (aux on Bus 4) -> Stereo Out,
    // sends to Bus 5; strip 2: Drum Verb (aux on Bus 5, stereo) -> Stereo Out; strip 3: Stereo Out
    chunk('AuCO', strip(0x40, 90, 64, 4), 0),
    chunk('AuCO', strip(0x42, 70, 64, 0, { 94: 8, 123: 2 }), 1),
    chunk('AuCO', strip(0x42, 127, 0, 0, { 94: 9, 123: 2 }), 2),
    chunk('AuCO', strip(0x4c, 90, 64, 0, { 123: 2 }), 3),
    chunk('Envi', envi('Kick', 0)),
    chunk('Envi', envi('Kick Bus', 1)),
    chunk('Envi', envi('Drum Verb', 2)),
    chunk('AuCU', plugin('Silencer'), 0, 7),
    chunk('AuCU', send(0, 5, 70), 0, 0),
    chunk('AuCU', send(0, 5, 90), 1, 0),
    chunk('AuCU', plugin('Silencer'), 3, 7),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) (out.set(p, i), (i += p.length));
  return out;
}

describe('Logic Pro import', () => {
  it('reads strips, names, plugins and sends', () => {
    const p = readLogicProject(project());
    const kick = p.strips.find((s) => s.name === 'Kick')!;
    expect(kick).toMatchObject({ kind: 'audio', output: 4, stereo: false, fader: 90 });
    expect(kick.plugins[0]).toMatchObject({ name: 'Silencer', type: 'aufx', subtype: 'Slnc', manufacturer: 'BLSA' });
    expect(kick.sends).toEqual([{ slot: 0, bus: 5, level: 70 }]);
    expect(p.strips.find((s) => s.name === 'Kick Bus')).toMatchObject({ kind: 'aux', input: 4, stereo: true });
    expect(() => readLogicProject(new Uint8Array(100))).toThrow();
  });

  it("Logic's fader scale: 90 = 0 dB, 127 = +6 dB, 0 = off", () => {
    expect(logicDb(90)).toBe(0);
    expect(logicDb(127)).toBe(6);
    expect(logicDb(0)).toBe(-Infinity);
  });

  it('builds a show: auxes become created buses, tracks routed and sending, AU state kept', () => {
    const { show, report } = logicToShow(readLogicProject(project()), 'Imported', defaultState());
    expect(report).toMatchObject({ channels: 1, buses: 2, plugins: 2, sends: 2, dropped: [] });
    const [kick] = show.channels;
    const kickBus = show.buses.find((b) => b.name === 'Kick Bus')!;
    const verb = show.buses.find((b) => b.name === 'Drum Verb')!;
    expect(kick).toMatchObject({ name: 'Kick', mainAssign: false, routes: [kickBus.id], faderDb: 0, pan: 0 });
    expect(kick.source).toMatchObject({ kind: 'input', deviceChannel: 0 });
    expect(kick.sends[verb.id]).toMatchObject({ on: true, tap: 'post' });
    expect(kick.inserts[0].pluginId).toBe('aucode:aufx,Slnc,BLSA');
    expect(atob(kick.inserts[0].state!.slice(4))).toBe(XML);
    expect(kickBus).toMatchObject({ created: true, role: 'group', output: 'main' });
    expect(kickBus.sends?.[verb.id]).toMatchObject({ on: true, levelDb: 0 });
    expect(verb).toMatchObject({ created: true, role: 'fx', output: 'main', faderDb: 6 });
    expect(show.buses.filter((b) => b.created).length).toBe(2);
    expect(show.main.inserts.length).toBe(1);
    // the demo show's buses are gone from the output patch
    expect(show.io.outputPatch.some((o) => o?.src === 'bus7')).toBe(false);
  });
});

describe('bus sends', () => {
  const s0 = defaultState();
  const s = {
    ...s0,
    buses: s0.buses.map((b) =>
      b.id === 'bus20' ? { ...b, created: true, output: 'main' as const, sends: { bus21: { on: true, levelDb: -6, pre: false, tap: 'post' as const } } }
      : b.id === 'bus21' ? { ...b, created: true, output: 'main' as const }
      : b,
    ),
  };
  it('a sending bus is processed before the bus it sends to', () => {
    const order = busOrder(s);
    expect(order.indexOf('bus20')).toBeLessThan(order.indexOf('bus21'));
  });
  it('sends count as feeds for loop checks', () => {
    expect(createsLoop(s, 'bus21', 'bus20')).toBe(true);
  });
  it('the plan carries bus sends (pre sends cut when the bus is muted)', () => {
    const plan = buildMixPlan(s) as any;
    expect(plan.buses.find((b: any) => b.id === 'bus20').sends).toEqual([{ bus: 'bus21', gain: 0.501187, pre: false }]);
    const pre = { ...s, buses: s.buses.map((b) => (b.id === 'bus20' ? { ...b, mute: true, sends: { bus21: { on: true, levelDb: 0, pre: true, tap: 'pre' as const } } } : b)) };
    expect((buildMixPlan(pre) as any).buses.find((b: any) => b.id === 'bus20').sends[0].gain).toBe(0);
  });
});
