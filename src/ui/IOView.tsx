// I/O: everything about where signals come from and go, on one page.
//   Channels : name, colour, mono/stereo, input, and output routing (Main LR + buses) per channel
//   Buses    : create / name / colour / type / output / delete (only created buses appear anywhere)
//   Outputs  : physical output patch
//   Devices  : audio interface, plugins, talkback, MIDI

import { useState } from 'react';
import { BUS_ROLES, createBus, deleteBus, roleOf, routableBuses, createdBuses } from '../core/buses';
import { PALETTE } from '../core/defaults';
import { createsLoop } from '../core/plan';
import { useConsole } from '../core/store';
import type { Bus, BusRole, Channel } from '../core/types';
import { MonoStereoSwitch } from './Strip';
import { InputPatch, MidiPanel, OutputPatch, TalkbackPanel, DevicesPanel } from './PatchView';
import { NativePanel } from './NativePanel';
import { useNative } from '../native/bridge';
import { useEngineInputs } from './useEngine';

type Section = 'channels' | 'buses' | 'outputs' | 'devices';
const SECTIONS: [Section, string][] = [
  ['channels', 'Channels'],
  ['buses', 'Buses'],
  ['outputs', 'Outputs'],
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

function InputSelect({ ch }: { ch: Channel }) {
  const s = useConsole();
  const { devices, channelsFor, channelName } = useEngineInputs();
  const value = ch.source.kind === 'input' ? `in:${ch.source.deviceId ?? ''}:${ch.source.deviceChannel ?? 0}` : ch.source.kind;
  return (
    <select
      className="io-input"
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        if (v.startsWith('in:')) {
          const [, deviceId, n] = v.split(':');
          s.updateChannel(ch.id, { source: { ...ch.source, kind: 'input', deviceId, deviceChannel: Number(n), deviceChannelR: undefined } });
        } else s.updateChannel(ch.id, { source: { ...ch.source, kind: v as Channel['source']['kind'] } });
      }}
    >
      <option value="none">— No source</option>
      {devices.map((d) => (
        <optgroup key={d.deviceId} label={d.label || d.deviceId.slice(0, 8)}>
          {Array.from({ length: channelsFor(d.deviceId) }, (_, i) =>
            ch.stereo && i + 1 >= channelsFor(d.deviceId) ? null : (
              <option key={i} value={`in:${d.deviceId}:${i}`}>
                {ch.stereo ? `${channelName(d.deviceId, i)} + ${i + 2}` : channelName(d.deviceId, i)}
              </option>
            ),
          )}
        </optgroup>
      ))}
      {ch.source.kind === 'input' && !devices.some((d) => d.deviceId === ch.source.deviceId) && (
        <option value={value}>(offline) In {(ch.source.deviceChannel ?? 0) + 1}</option>
      )}
      <optgroup label="Test sources">
        <option value="tone">Test tone</option>
        <option value="noise">Pink noise</option>
        <option value="speech">Speech sim</option>
      </optgroup>
    </select>
  );
}

function ChannelsSection() {
  const s = useConsole();
  const buses = routableBuses(s);
  const toggleRoute = (chId: string, busId: string) =>
    s.updateChannel(chId, (c) => ({ routes: (c.routes ?? []).includes(busId) ? (c.routes ?? []).filter((x) => x !== busId) : [...(c.routes ?? []), busId] }));
  return (
    <div className="panel io-panel">
      <div className="panel-title">Channels</div>
      <p className="hint">Name, colour and input on the left · output routing on the right (after the fader and pan; click a cell). A dot means the channel has a send to that bus (sends are on each strip).</p>
      <div className="io-scroll">
        <table className="io-table">
          <thead>
            <tr>
              <th className="io-num">#</th>
              <th className="io-name-h">Name</th>
              <th>Width</th>
              <th>Input</th>
              <th className="io-route-h main">Main LR</th>
              {buses.map((b) => (
                <th key={b.id} className="io-route-h" style={{ borderTopColor: b.color }} title={`${b.name}${roleOf(b) ? ` (${roleOf(b)!.label})` : ''}`}>
                  <span className="io-bus-name">{b.name}</span>
                  {roleOf(b) && <span className="io-role">{roleOf(b)!.short}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.channels.map((c) => (
              <tr key={c.id}>
                <td className="io-num">{c.id.slice(2).padStart(2, '0')}</td>
                <td className="io-name">
                  <ColorDot value={c.color} onChange={(color) => s.updateChannel(c.id, { color })} />
                  <input value={c.name} onChange={(e) => s.updateChannel(c.id, { name: e.target.value })} aria-label={`Channel ${c.id.slice(2)} name`} />
                </td>
                <td className="io-width"><MonoStereoSwitch ch={c} /></td>
                <td><InputSelect ch={c} /></td>
                <td className={'rg-cell' + (c.mainAssign ? ' on' : '')} onClick={() => s.updateChannel(c.id, { mainAssign: !c.mainAssign })} title="Main LR">
                  {c.mainAssign ? '●' : ''}
                </td>
                {buses.map((b) => {
                  const on = (c.routes ?? []).includes(b.id);
                  const send = c.sends[b.id]?.on;
                  return (
                    <td
                      key={b.id}
                      className={'rg-cell' + (on ? ' on' : '') + (send && !on ? ' rg-send' : '')}
                      style={on ? { background: b.color } : undefined}
                      title={send && !on ? `Has a send to ${b.name}` : on ? `Assigned to ${b.name}: click to remove` : `Assign to ${b.name}`}
                      onClick={() => toggleRoute(c.id, b.id)}
                    >
                      {on ? '●' : send ? '·' : ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {buses.length === 0 && <p className="hint">No buses yet: create one under Buses (or from a strip's Output / send menu).</p>}
    </div>
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
      return (localStorage.getItem('merge.io.section') as Section) || 'channels';
    } catch {
      return 'channels';
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
      {section === 'channels' && <ChannelsSection />}
      {section === 'buses' && <BusesSection />}
      {section === 'outputs' && (
        <div className="grid2">
          <OutputPatch />
          {!nativeOn && <InputPatch />}
        </div>
      )}
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
