// Routing page: the whole signal flow on one screen. Rows are channels, columns are Main LR
// and the buses; click a cell to assign that channel's output there. Below, every bus's output.

import { useMemo, useState } from 'react';
import { createsLoop } from '../core/plan';
import { useConsole } from '../core/store';
import type { Bus } from '../core/types';

export function RoutingView() {
  const s = useConsole();
  const [showAll, setShowAll] = useState(false);
  const used = (b: Bus) =>
    b.output !== 'main' ||
    b.name !== `Bus ${b.id.slice(3)}` ||
    b.inserts.length > 0 ||
    s.channels.some((c) => (c.routes ?? []).includes(b.id) || c.sends[b.id]?.on) ||
    s.buses.some((x) => x.output === b.id);
  const columns = useMemo(() => s.buses.filter((b) => b.type !== 'mixminus' && (showAll || used(b))), [s.buses, s.channels, showAll]);
  const toggleRoute = (chId: string, busId: string) =>
    s.updateChannel(chId, (c) => ({ routes: (c.routes ?? []).includes(busId) ? (c.routes ?? []).filter((x) => x !== busId) : [...(c.routes ?? []), busId] }));

  return (
    <div className="page routing-page">
      <div className="panel">
        <div className="panel-title row between">
          <span>Channel outputs</span>
          <label className="row">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> show all 64 buses
          </label>
        </div>
        <p className="hint">
          Click a cell to send a channel's output there (after its fader and pan). Typical: drums → Drums bus with Main LR off, Drums bus → Main LR. Name a bus (or
          tick "show all") to get a column for it. Sends with their own level (aux, FX, feeds) are on each channel's SENDS tab.
        </p>
        <div className="routing-scroll">
          <table className="routing-grid">
            <thead>
              <tr>
                <th className="rg-name">Channel</th>
                <th className="rg-col main">Main LR</th>
                {columns.map((b) => (
                  <th key={b.id} className="rg-col" style={{ borderTopColor: b.color }} title={b.name}>
                    <span className="rg-num">{b.id.slice(3)}</span>
                    <span className="rg-bus">{b.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.channels.map((c) => (
                <tr key={c.id}>
                  <td className="rg-name">
                    <span className="hint">{c.id.slice(2)}</span> {c.name}
                  </td>
                  <td className={'rg-cell' + (c.mainAssign ? ' on' : '')} onClick={() => s.updateChannel(c.id, { mainAssign: !c.mainAssign })}>
                    {c.mainAssign ? '●' : ''}
                  </td>
                  {columns.map((b) => {
                    const on = (c.routes ?? []).includes(b.id);
                    const send = c.sends[b.id]?.on;
                    return (
                      <td
                        key={b.id}
                        className={'rg-cell' + (on ? ' on' : '') + (send && !on ? ' send' : '')}
                        style={on ? { background: b.color } : undefined}
                        title={send && !on ? 'Has a send to this bus (SENDS tab)' : on ? 'Assigned: click to remove' : 'Click to assign'}
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
      </div>

      <div className="panel">
        <div className="panel-title">Bus outputs</div>
        <p className="hint">Where each bus goes after its fader: Main LR, another bus (Drums → Band → Main), or nowhere (a feed to physical outputs only).</p>
        <div className="bus-outputs">
          {s.buses
            .filter((b) => showAll || used(b))
            .map((b) => (
              <label key={b.id} className="row bus-out-row">
                <span className="rg-num">{b.id.slice(3)}</span>
                <input
                  className="bus-name"
                  value={b.name}
                  onChange={(e) => s.updateBus(b.id, { name: e.target.value })}
                  style={{ borderLeft: `3px solid ${b.color}` }}
                />
                {b.type === 'mixminus' ? (
                  <span className="hint">mix-minus (auto)</span>
                ) : (
                  <select value={b.output ?? 'none'} onChange={(e) => s.updateBus(b.id, { output: e.target.value })}>
                    <option value="main">→ Main LR</option>
                    <option value="none">→ outputs only</option>
                    {s.buses
                      .filter((x) => x.id !== b.id && x.type !== 'mixminus' && !createsLoop(s, b.id, x.id))
                      .map((x) => <option key={x.id} value={x.id}>→ {x.id.slice(3)} · {x.name}</option>)}
                  </select>
                )}
              </label>
            ))}
        </div>
      </div>
    </div>
  );
}
