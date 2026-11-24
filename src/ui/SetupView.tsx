import { useState } from 'react';
import { describeAction } from '../core/actions';
import { LAYER_SLOTS, newId } from '../core/defaults';
import { useConsole } from '../core/store';
import type { Layer, StripRef } from '../core/types';
import { KeyEditor } from './UserKeys';

const refToValue = (r: StripRef | null) => (!r ? '' : r.kind === 'main' ? 'main' : `${r.kind}:${r.id}`);
const valueToRef = (v: string): StripRef | null => {
  if (!v) return null;
  if (v === 'main') return { kind: 'main' };
  const [kind, id] = v.split(':');
  return { kind: kind as 'channel' | 'bus' | 'dca', id };
};

function LayerEditor() {
  const s = useConsole();
  const [sel, setSel] = useState(s.currentLayer);
  const layer = s.layers.find((l) => l.id === sel) ?? s.layers[0];
  const setLayers = (layers: Layer[]) => s.update(() => ({ layers }));
  const upLayer = (p: Partial<Layer>) => setLayers(s.layers.map((l) => (l.id === layer.id ? { ...l, ...p } : l)));

  return (
    <div className="panel">
      <div className="panel-title">Custom layers / pages</div>
      <p className="hint">Any channel, bus, DCA or the main can go in any fader slot, in any order, on as many layers as you like.</p>
      <div className="row wrap">
        {s.layers.map((l) => (
          <button key={l.id} className={'layer-btn' + (l.id === layer?.id ? ' on' : '')} onClick={() => setSel(l.id)}>
            {l.name}
          </button>
        ))}
        <button
          onClick={() => {
            const id = newId('L');
            setLayers([...s.layers, { id, name: `Layer ${s.layers.length + 1}`, slots: Array(LAYER_SLOTS).fill(null) }]);
            setSel(id);
          }}
        >
          + New layer
        </button>
      </div>
      {layer && (
        <>
          <div className="row">
            <input value={layer.name} onChange={(e) => upLayer({ name: e.target.value })} />
            <button
              onClick={() => {
                const id = newId('L');
                setLayers([...s.layers, { ...structuredClone(layer), id, name: layer.name + ' copy' }]);
                setSel(id);
              }}
            >
              Duplicate
            </button>
            <button
              disabled={s.layers.length <= 1}
              onClick={() => {
                const rest = s.layers.filter((l) => l.id !== layer.id);
                s.update((st) => ({ layers: rest, currentLayer: st.currentLayer === layer.id ? rest[0].id : st.currentLayer }));
                setSel(rest[0].id);
              }}
            >
              Delete
            </button>
          </div>
          <div className="slot-grid">
            {layer.slots.map((r, i) => (
              <label key={i} className="slot">
                <span className="hint">Fader {i + 1}</span>
                <select
                  value={refToValue(r)}
                  onChange={(e) => upLayer({ slots: layer.slots.map((x, j) => (j === i ? valueToRef(e.target.value) : x)) })}
                >
                  <option value="">— empty —</option>
                  <optgroup label="Inputs">
                    {s.channels.map((c) => (
                      <option key={c.id} value={`channel:${c.id}`}>
                        {c.id.replace('ch', '')} {c.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Buses">
                    {s.buses.map((b) => (
                      <option key={b.id} value={`bus:${b.id}`}>
                        {b.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="DCAs">
                    {s.dcas.map((d) => (
                      <option key={d.id} value={`dca:${d.id}`}>
                        {d.name}
                      </option>
                    ))}
                  </optgroup>
                  <option value="main">Main LR</option>
                </select>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function GroupMatrix() {
  const s = useConsole();
  const toggle = (chId: string, field: 'muteGroups' | 'dcas', gid: string) =>
    s.updateChannel(chId, (c) => ({ [field]: c[field].includes(gid) ? c[field].filter((x) => x !== gid) : [...c[field], gid] }));
  return (
    <div className="panel">
      <div className="panel-title">Mute groups &amp; DCAs</div>
      <p className="hint">A channel can belong to several mute groups and DCAs. Mute groups never touch a channel's own mute button.</p>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th />
              {s.muteGroups.map((g) => (
                <th key={g.id}>
                  <input className="mini-input" value={g.name} onChange={(e) => s.updateMuteGroup(g.id, { name: e.target.value })} />
                </th>
              ))}
              <th className="sep" />
              {s.dcas.map((d) => (
                <th key={d.id}>
                  <input className="mini-input" value={d.name} onChange={(e) => s.updateDca(d.id, { name: e.target.value })} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.channels.map((c) => (
              <tr key={c.id}>
                <td className="row-label">
                  <span className="dot" style={{ background: c.color }} /> {c.id.replace('ch', '')} {c.name}
                </td>
                {s.muteGroups.map((g) => (
                  <td key={g.id}>
                    <button className={'cell mg' + (c.muteGroups.includes(g.id) ? ' on' : '')} onClick={() => toggle(c.id, 'muteGroups', g.id)} />
                  </td>
                ))}
                <td className="sep" />
                {s.dcas.map((d) => (
                  <td key={d.id}>
                    <button className={'cell' + (c.dcas.includes(d.id) ? ' on' : '')} onClick={() => toggle(c.id, 'dcas', d.id)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KeyList() {
  const s = useConsole();
  const [edit, setEdit] = useState<string | null>(null);
  return (
    <div className="panel">
      <div className="panel-title">User keys</div>
      {edit ? (
        <KeyEditor id={edit} onClose={() => setEdit(null)} />
      ) : (
        <table className="list">
          <tbody>
            {s.userKeys.map((k, i) => (
              <tr key={k.id} onClick={() => setEdit(k.id)} className="clickable">
                <td>{i + 1}</td>
                <td>
                  <span className="dot" style={{ background: k.color }} /> {k.label.replace('\n', ' ')}
                </td>
                <td className="hint">{k.actions.map((a) => describeAction(s, a)).join(' → ') || '—'}</td>
                <td>{k.mode === 'momentary' ? 'MOM' : ''}</td>
                <td>
                  <code>{k.hotkey ?? ''}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function SetupView() {
  return (
    <div className="page grid2">
      <div className="col">
        <LayerEditor />
        <KeyList />
      </div>
      <GroupMatrix />
    </div>
  );
}
