// One routing grid, three views: INPUT (interface inputs -> channels), INTERNAL (channels / buses
// -> Main LR / buses) and OUTPUT (Main / monitor / buses -> physical outputs). Rows are what
// you're setting up; columns are what can feed it (or where it goes); click a cell to connect.

import { useState } from 'react';
import { roleOf, routableBuses, createdBuses } from '../core/buses';
import { PALETTE } from '../core/defaults';
import { createsLoop } from '../core/plan';
import { useConsole } from '../core/store';
import type { Bus, Channel, OutputSource } from '../core/types';
import { useNative } from '../native/bridge';
import { MonoStereoSwitch } from './Strip';
import { useEngine, useEngineInputs } from './useEngine';

type View = 'input' | 'internal' | 'output';

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

/** Row header for a channel: number, colour, editable name, mono / stereo. */
function ChannelHead({ ch }: { ch: Channel }) {
  const s = useConsole();
  return (
    <th className="rg-row-head">
      <span className="rg-n">{ch.id.slice(2).padStart(2, '0')}</span>
      <ColorDot value={ch.color} onChange={(color) => s.updateChannel(ch.id, { color })} />
      <input className="rg-row-name" value={ch.name} onChange={(e) => s.updateChannel(ch.id, { name: e.target.value })} aria-label={`Channel ${ch.id.slice(2)} name`} />
      <MonoStereoSwitch ch={ch} />
    </th>
  );
}

function BusHead({ b }: { b: Bus }) {
  const s = useConsole();
  return (
    <th className="rg-row-head bus">
      <span className="rg-n">B{b.id.slice(3)}</span>
      <ColorDot value={b.color} onChange={(color) => s.updateBus(b.id, { color })} />
      <input className="rg-row-name" value={b.name} onChange={(e) => s.updateBus(b.id, { name: e.target.value })} aria-label="Bus name" />
      {roleOf(b) && <span className="io-role">{roleOf(b)!.short}</span>}
    </th>
  );
}

const ColHead = ({ label, sub, color, title, group }: { label: string; sub?: string; color?: string; title?: string; group?: boolean }) => (
  <th className={'rg-col-head' + (group ? ' group-start' : '')} style={color ? { borderTopColor: color } : undefined} title={title ?? label}>
    <span className="rg-col-label">{label}</span>
    {sub && <span className="rg-col-sub">{sub}</span>}
  </th>
);

// ---------------------------------------------------------------- INPUT
function InputGrid() {
  const s = useConsole();
  const { devices, channelsFor, channelName } = useEngineInputs();
  const cols: { key: string; deviceId: string; n: number; label: string; dev: string }[] = [];
  for (const d of devices) for (let i = 0; i < channelsFor(d.deviceId); i++) cols.push({ key: `${d.deviceId}:${i}`, deviceId: d.deviceId, n: i, label: channelName(d.deviceId, i), dev: d.label || d.deviceId });
  const tests: { kind: Channel['source']['kind']; label: string }[] = [
    { kind: 'tone', label: 'Tone' },
    { kind: 'noise', label: 'Noise' },
    { kind: 'speech', label: 'Speech' },
  ];
  const pick = (ch: Channel, deviceId: string, n: number) => {
    const cur = ch.source.kind === 'input' && ch.source.deviceId === deviceId && ch.source.deviceChannel === n;
    s.updateChannel(ch.id, { source: cur ? { ...ch.source, kind: 'none' } : { ...ch.source, kind: 'input', deviceId, deviceChannel: n, deviceChannelR: undefined } });
  };
  return (
    <table className="rgrid">
      <thead>
        <tr>
          <th className="rg-corner">Channel ↓ · Input →</th>
          {cols.map((c, i) => <ColHead key={c.key} label={String(c.n + 1)} sub={c.label !== `In ${c.n + 1}` ? c.label : undefined} title={`${c.dev}: ${c.label}`} group={i === 0} />)}
          {tests.map((t, i) => <ColHead key={t.kind} label={t.label} sub="test" group={i === 0} />)}
        </tr>
      </thead>
      <tbody>
        {s.channels.map((ch) => {
          const l = ch.source.kind === 'input' ? ch.source.deviceChannel ?? 0 : -1;
          const r = ch.stereo ? ch.source.deviceChannelR ?? l + 1 : -1;
          return (
            <tr key={ch.id}>
              <ChannelHead ch={ch} />
              {cols.map((c, i) => {
                const mine = ch.source.kind === 'input' && (ch.source.deviceId ?? c.deviceId) === c.deviceId;
                const isL = mine && c.n === l;
                const isR = mine && c.n === r;
                return (
                  <td
                    key={c.key}
                    className={'rg-x' + (isL || isR ? ' on' : '') + (isR ? ' right' : '') + (i === 0 ? ' group-start' : '')}
                    style={isL || isR ? { background: ch.color } : undefined}
                    title={`${c.label} → ${ch.name}${isL ? (ch.stereo ? ' (left)' : '') : isR ? ' (right)' : ''}`}
                    onClick={() => pick(ch, c.deviceId, c.n)}
                  >
                    {isL ? (ch.stereo ? 'L' : '●') : isR ? 'R' : ''}
                  </td>
                );
              })}
              {tests.map((t, i) => {
                const on = ch.source.kind === t.kind;
                return (
                  <td key={t.kind} className={'rg-x' + (on ? ' on' : '') + (i === 0 ? ' group-start' : '')} style={on ? { background: ch.color } : undefined}
                    onClick={() => s.updateChannel(ch.id, { source: { ...ch.source, kind: on ? 'none' : t.kind } })} title={`${t.label} → ${ch.name}`}>
                    {on ? '●' : ''}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------- INTERNAL
function InternalGrid() {
  const s = useConsole();
  const buses = routableBuses(s);
  const toggleRoute = (chId: string, busId: string) =>
    s.updateChannel(chId, (c) => ({ routes: (c.routes ?? []).includes(busId) ? (c.routes ?? []).filter((x) => x !== busId) : [...(c.routes ?? []), busId] }));
  return (
    <table className="rgrid">
      <thead>
        <tr>
          <th className="rg-corner">From ↓ · To →</th>
          <ColHead label="Main LR" color="var(--ok)" group />
          {buses.map((b) => <ColHead key={b.id} label={b.name} sub={roleOf(b)?.short} color={b.color} />)}
        </tr>
      </thead>
      <tbody>
        {s.channels.map((c) => (
          <tr key={c.id}>
            <ChannelHead ch={c} />
            <td className={'rg-x group-start' + (c.mainAssign ? ' on' : '')} style={c.mainAssign ? { background: 'var(--ok)' } : undefined} onClick={() => s.updateChannel(c.id, { mainAssign: !c.mainAssign })} title={`${c.name} → Main LR`}>
              {c.mainAssign ? '●' : ''}
            </td>
            {buses.map((b) => {
              const on = (c.routes ?? []).includes(b.id);
              const send = c.sends[b.id]?.on;
              return (
                <td key={b.id} className={'rg-x' + (on ? ' on' : '') + (send && !on ? ' send' : '')} style={on ? { background: b.color } : undefined}
                  title={send && !on ? `${c.name} has a send to ${b.name}` : `${c.name} → ${b.name}`} onClick={() => toggleRoute(c.id, b.id)}>
                  {on ? '●' : send ? '·' : ''}
                </td>
              );
            })}
          </tr>
        ))}
        {buses.length > 0 && (
          <tr className="rg-sep"><td colSpan={buses.length + 2}>Buses (each goes to one place)</td></tr>
        )}
        {buses.map((b) => {
          const toMain = b.output === 'main';
          return (
            <tr key={b.id}>
              <BusHead b={b} />
              <td className={'rg-x group-start' + (toMain ? ' on' : '')} style={toMain ? { background: 'var(--ok)' } : undefined}
                onClick={() => s.updateBus(b.id, { output: toMain ? 'none' : 'main' })} title={`${b.name} → Main LR`}>
                {toMain ? '●' : ''}
              </td>
              {buses.map((x) => {
                const self = x.id === b.id;
                const loop = !self && createsLoop(s, b.id, x.id);
                const on = b.output === x.id;
                return (
                  <td key={x.id} className={'rg-x' + (on ? ' on' : '') + (self || loop ? ' na' : '')} style={on ? { background: x.color } : undefined}
                    title={self ? '' : loop ? `${b.name} → ${x.name} would make a loop` : `${b.name} → ${x.name}`}
                    onClick={() => !self && !loop && s.updateBus(b.id, { output: on ? 'none' : x.id })}>
                    {on ? '●' : ''}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------- OUTPUT
function OutputGrid() {
  const s = useConsole();
  const engine = useEngine();
  const native = useNative();
  const names = native.status === 'connected' ? native.device?.outputs : undefined;
  const max = names ? names.length : engine?.maxOutputChannels ?? 2;
  const rows = Math.max(2, Math.min(64, Math.max(max, s.io.outputPatch.length)));
  const sources: { src: string; side: 0 | 1; label: string; sub: string; color?: string; group?: boolean }[] = [
    { src: 'main', side: 0, label: 'Main', sub: 'L', color: 'var(--ok)', group: true },
    { src: 'main', side: 1, label: 'Main', sub: 'R', color: 'var(--ok)' },
    { src: 'monitor', side: 0, label: 'Monitor', sub: 'L', color: 'var(--text-secondary)', group: true },
    { src: 'monitor', side: 1, label: 'Monitor', sub: 'R', color: 'var(--text-secondary)' },
    ...createdBuses(s).flatMap((b) => [
      { src: b.id, side: 0 as const, label: b.name, sub: 'L', color: b.color, group: true },
      { src: b.id, side: 1 as const, label: b.name, sub: 'R', color: b.color },
    ]),
  ];
  const set = (i: number, o: OutputSource | null) =>
    s.update((st) => {
      const patch = st.io.outputPatch.slice();
      while (patch.length <= i) patch.push(null);
      patch[i] = o;
      return { io: { ...st.io, outputPatch: patch } };
    });
  return (
    <table className="rgrid">
      <thead>
        <tr>
          <th className="rg-corner">Output ↓ · Source →</th>
          {sources.map((x) => <ColHead key={`${x.src}:${x.side}`} label={x.label} sub={x.sub} color={x.color} group={x.group} />)}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, i) => {
          const cur = s.io.outputPatch[i];
          return (
            <tr key={i} className={i >= max ? 'offline' : ''}>
              <th className="rg-row-head out">
                <span className="rg-n">{i + 1}</span>
                <span className="rg-out-name">{names?.[i] ?? `Out ${i + 1}`}</span>
                {i >= max && <span className="hint">not connected</span>}
              </th>
              {sources.map((x) => {
                const on = cur?.src === x.src && cur.side === x.side;
                return (
                  <td key={`${x.src}:${x.side}`} className={'rg-x' + (on ? ' on' : '') + (x.group ? ' group-start' : '')} style={on ? { background: x.color } : undefined}
                    title={`${x.label} ${x.sub} → ${names?.[i] ?? `Out ${i + 1}`}`} onClick={() => set(i, on ? null : { src: x.src, side: x.side })}>
                    {on ? '●' : ''}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const VIEWS: { id: View; label: string; about: string }[] = [
  { id: 'input', label: 'INPUT', about: 'Which interface input (or test source) feeds each channel. A stereo channel takes the input you click and the next one.' },
  { id: 'internal', label: 'INTERNAL', about: 'Where each channel goes after its fader and pan (Main LR and / or buses), and where each bus goes. Sends are on each strip; a small dot shows a send.' },
  { id: 'output', label: 'OUTPUT', about: 'What feeds each physical output of the interface: Main LR, the monitor, or a bus.' },
];

export function RoutingGrid() {
  const [view, setView] = useState<View>(() => {
    try {
      return (localStorage.getItem('merge.routing.view') as View) || 'input';
    } catch {
      return 'input';
    }
  });
  const choose = (v: View) => {
    setView(v);
    try {
      localStorage.setItem('merge.routing.view', v);
    } catch {
      /* storage unavailable */
    }
  };
  const inputsOpen = useEngineInputs().devices.length > 0;
  return (
    <div className="panel io-panel routing-panel">
      <div className="rg-toolbar">
        <div className="rg-views" role="tablist" aria-label="Routing view">
          {VIEWS.map((v) => (
            <button key={v.id} role="tab" aria-selected={view === v.id} className={'rg-view' + (view === v.id ? ' on' : '')} title={v.about} onClick={() => choose(v.id)}>
              {v.label}
            </button>
          ))}
        </div>

      </div>
      <div className="rg-scroll">
        {view === 'input' && <InputGrid />}
        {view === 'input' && !inputsOpen && <p className="hint rg-empty">No audio interface open.</p>}
        {view === 'internal' && <InternalGrid />}
        {view === 'output' && <OutputGrid />}
      </div>
    </div>
  );
}
