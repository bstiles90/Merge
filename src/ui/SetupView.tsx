import { useState } from 'react';
import { describeAction } from '../core/actions';
import { LAYER_SLOTS, newId } from '../core/defaults';
import { useConsole } from '../core/store';
import type { Layer } from '../core/types';
import { StripRefSelect } from './Pages';
import { deletePage } from '../core/layers';
import { KeyEditor } from './UserKeys';
import { MacrosPanel } from './MacrosPanel';


function LayerEditor() {
  const s = useConsole();
  const [sel, setSel] = useState(s.currentLayer);
  const layer = s.layers.find((l) => l.id === sel) ?? s.layers[0];
  const setLayers = (layers: Layer[]) => s.update(() => ({ layers }));
  const upLayer = (p: Partial<Layer>) => setLayers(s.layers.map((l) => (l.id === layer.id ? { ...l, ...p } : l)));

  return (
    <div className="panel">
      <div className="panel-title">Fader pages</div>
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
                s.update((st) => deletePage(st, layer.id));
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
                <StripRefSelect value={r} onChange={(ref) => upLayer({ slots: layer.slots.map((x, j) => (j === i ? ref : x)) })} />
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

function MeteringPanel() {
  const s = useConsole();
  const y = s.meterYellowDb ?? -10;
  return (
    <div className="panel">
      <div className="panel-title">Metering</div>
      <div className="row wrap">
        <span>Meters turn yellow at</span>
        <select value={y} onChange={(e) => s.update(() => ({ meterYellowDb: Number(e.target.value) }))}>
          <option value={-10}>-10 dBFS (Waves LV1)</option>
          <option value={-18}>-18 dBFS (dLive, Wing, M32, CL)</option>
          <option value={-12}>-12 dBFS</option>
          <option value={-20}>-20 dBFS (EBU-style)</option>
        </select>
      </div>
      <p className="hint">Set each channel's gain so its meter just touches yellow on the loud parts. Red is the top 3 dB before clipping.</p>
    </div>
  );
}

export function SetupView() {
  return (
    <div className="page grid2">
      <div className="col">
        <MacrosPanel />
        <KeyList />
        <LayerEditor />
      </div>
      <div className="col">
        <GroupMatrix />
        <MeteringPanel />
      </div>
    </div>
  );
}
