// I/O: everything about where signals come from and go, on one page.
//   Routing  : one grid, three views - INPUT, INTERNAL, OUTPUT (RoutingGrid)
//   Buses    : create / name / colour / type / output / delete (only created buses appear anywhere)
//   Devices  : audio interface, plugins, talkback, MIDI

import { useState } from 'react';
import { BUS_ROLES, createBus, deleteBus, routableBuses, createdBuses } from '../core/buses';
import { PALETTE } from '../core/defaults';
import { createsLoop } from '../core/plan';
import { useConsole } from '../core/store';
import type { Bus, BusRole } from '../core/types';
import { MidiPanel, TalkbackPanel, DevicesPanel } from './PatchView';
import { NativePanel } from './NativePanel';
import { useNative } from '../native/bridge';
import { RoutingGrid } from './RoutingGrid';

type Section = 'routing' | 'buses' | 'devices';
const SECTIONS: [Section, string][] = [
  ['routing', 'Routing'],
  ['buses', 'Buses'],
  ['devices', 'Devices & MIDI'],
];

/** A colour dot that opens the palette. */
function ColorDot({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="color-dot-wrap">
      <button className="color-dot" style={{ background: value }} title="Colour" onClick={() => setOpen(!open)} />
      {open && (
        <span className="color-pop" onMouseLeave={() => setOpen(false)}>
          {PALETTE.map((c) => (
            <button key={c} className={'swatch' + (c === value ? ' on' : '')} style={{ background: c }} onClick={() => { onChange(c); setOpen(false); }} />
          ))}
        </span>
      )}
    </span>
  );
}

function BusRow({ b }: { b: Bus }) {
  const s = useConsole();
  const [confirm, setConfirm] = useState(false);
  const fed = s.channels.filter((c) => (c.routes ?? []).includes(b.id) || c.sends[b.id]?.on).length + s.buses.filter((x) => x.output === b.id).length;
  const outs = s.io.outputPatch.map((o, i) => (o?.src === b.id ? i + 1 : 0)).filter(Boolean);
  return (
    <tr>
      <td className="io-num">{b.id.slice(3)}</td>
      <td className="io-name">
        <ColorDot value={b.color} onChange={(color) => s.updateBus(b.id, { color })} />
        <input value={b.name} onChange={(e) => s.updateBus(b.id, { name: e.target.value })} aria-label="Bus name" />
      </td>
      <td>
        {b.type === 'mixminus' ? (
          <span className="hint">Mix-minus (auto)</span>
        ) : (
          <select value={b.role ?? ''} onChange={(e) => s.updateBus(b.id, { role: (e.target.value || undefined) as BusRole | undefined })}>
            <option value="">—</option>
            {BUS_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        )}
      </td>
      <td>
        {b.type === 'mixminus' ? (
          <span className="hint">outputs</span>
        ) : (
          <select value={b.output ?? 'none'} onChange={(e) => s.updateBus(b.id, { output: e.target.value })}>
            <option value="main">→ Main LR</option>
            <option value="none">→ Outputs only</option>
            {routableBuses(s)
              .filter((x) => x.id !== b.id && !createsLoop(s, b.id, x.id))
              .map((x) => <option key={x.id} value={x.id}>→ {x.name}</option>)}
          </select>
        )}
      </td>
      <td className="hint">{outs.length ? `Out ${outs.join(', ')}` : '—'}</td>
      <td className="hint">{fed ? `${fed} feeding` : 'nothing yet'}</td>
      <td>
        <button
          className={'icon-btn' + (confirm ? ' confirm' : '')}
          title="Delete this bus (sends, assignments and patch to it are removed)"
          onClick={() => {
            if (!confirm) return setConfirm(true);
            s.update((st) => deleteBus(st, b.id));
          }}
          onMouseLeave={() => setConfirm(false)}
        >
          {confirm ? 'Delete?' : '✕'}
        </button>
      </td>
    </tr>
  );
}

function BusesSection() {
  const s = useConsole();
  const list = createdBuses(s);
  const free = s.buses.length - list.length;
  return (
    <div className="panel io-panel">
      <div className="panel-title row between">
        <span>Buses</span>
        <span className="hint">{list.length} created · {free} of {s.buses.length} free</span>
      </div>
      <div className="new-bus-row">
        {BUS_ROLES.map((r) => (
          <button key={r.id} className="new-bus" disabled={!free} title={r.about} onClick={() => s.update((st) => createBus(st, r.id).patch)}>
            <b>+ {r.label}</b>
            <span className="hint">{r.about}</span>
          </button>
        ))}
      </div>
      <table className="io-table buses">
        <thead>
          <tr>
            <th className="io-num">#</th>
            <th className="io-name-h">Name</th>
            <th>Type</th>
            <th>Goes to</th>
            <th>Physical outs</th>
            <th>Fed by</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((b) => <BusRow key={b.id} b={b} />)}
        </tbody>
      </table>
      {!list.length && <p className="hint">No buses yet. Create one above.</p>}
    </div>
  );
}

export function IOView() {
  const [section, setSection] = useState<Section>(() => {
    try {
      const v = localStorage.getItem('merge.io.section') as Section;
      return SECTIONS.some(([id]) => id === v) ? v : 'routing';
    } catch {
      return 'routing';
    }
  });
  const nativeOn = useNative((st) => st.status === 'connected');
  const choose = (x: Section) => {
    setSection(x);
    try {
      localStorage.setItem('merge.io.section', x);
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <div className="page io-page">
      <nav className="io-sections" aria-label="I/O section">
        {SECTIONS.map(([id, label]) => (
          <button key={id} className={'io-sec' + (section === id ? ' on' : '')} onClick={() => choose(id)}>
            {label}
          </button>
        ))}
      </nav>
      {section === 'routing' && <RoutingGrid />}
      {section === 'buses' && <BusesSection />}
      {section === 'devices' && (
        <div className="grid2">
          <div className="col">
            <NativePanel />
            {!nativeOn && <DevicesPanel />}
          </div>
          <div className="col">
            <TalkbackPanel />
            <MidiPanel />
          </div>
        </div>
      )}
    </div>
  );
}
