// Fader pages (layers) on the mix surface: a column of big page keys next to the
// faders, like the layer keys on a dLive / LV1 / M32, plus on-surface page editing.

import { useState } from 'react';
import { LAYER_SLOTS, newId, PALETTE } from '../core/defaults';
import { addToPage, moveSlot } from '../core/layers';
import { useConsole } from '../core/store';
import type { ConsoleState, Layer, StripRef } from '../core/types';
import { ColorPicker } from './Detail';
import { Strip } from './Strip';

const STRIP_MIME = 'application/x-merge-strip';

export const refToValue = (r: StripRef | null) => (!r ? '' : r.kind === 'main' ? 'main' : `${r.kind}:${r.id}`);
export const valueToRef = (v: string): StripRef | null => {
  if (!v) return null;
  if (v === 'main') return { kind: 'main' };
  const [kind, id] = v.split(':');
  return { kind: kind as 'channel' | 'bus' | 'dca', id };
};

export function StripRefSelect({ value, onChange, className }: { value: StripRef | null; onChange: (r: StripRef | null) => void; className?: string }) {
  const s = useConsole();
  return (
    <select className={className} value={refToValue(value)} onChange={(e) => onChange(valueToRef(e.target.value))}>
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
  );
}

/** Colour of whatever sits in a slot, for the page-key preview. */
function refColor(s: ConsoleState, r: StripRef | null): string | null {
  if (!r) return null;
  if (r.kind === 'channel') return s.channels.find((c) => c.id === r.id)?.color ?? null;
  if (r.kind === 'bus') return s.buses.find((c) => c.id === r.id)?.color ?? null;
  if (r.kind === 'dca') return s.dcas.find((c) => c.id === r.id)?.color ?? null;
  return '#c9ccd1';
}

export function layerColor(l: Layer, i: number) {
  return l.color ?? PALETTE[(i + 5) % 8];
}

export function PageKeys({ editing, setEditing }: { editing: boolean; setEditing: (b: boolean) => void }) {
  const s = useConsole();
  const current = s.layers.find((l) => l.id === s.currentLayer) ?? s.layers[0];
  const setLayers = (layers: Layer[], currentLayer?: string) => s.update((st) => ({ layers, currentLayer: currentLayer ?? st.currentLayer }));
  const upCurrent = (p: Partial<Layer>) => setLayers(s.layers.map((l) => (l.id === current.id ? { ...l, ...p } : l)));

  return (
    <div className={'pages' + (editing ? ' editing' : '')}>
      <div className="pages-title">PAGES</div>
      <div className="pages-nav">
        <button onClick={() => s.dispatch({ type: 'layer.prev', args: {} })} title="Previous page">▲</button>
        <button onClick={() => s.dispatch({ type: 'layer.next', args: {} })} title="Next page">▼</button>
      </div>
      <div className="page-keys">
        {s.layers.map((l, i) => {
          const on = l.id === current?.id;
          const color = layerColor(l, i);
          return (
            <button
              key={l.id}
              className={'page-key' + (on ? ' on' : '')}
              style={{ ['--pc' as string]: color }}
              onClick={() => s.dispatch({ type: 'layer.select', args: { id: l.id } })}
              title={`${i < 9 ? `Press ${i + 1} to select. ` : ''}Drop a strip here to add it to this page.`}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(STRIP_MIME) || on) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                e.currentTarget.classList.add('drop-target');
              }}
              onDragLeave={(e) => e.currentTarget.classList.remove('drop-target')}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove('drop-target');
                const data = e.dataTransfer.getData(STRIP_MIME);
                if (!data) return;
                const { ref } = JSON.parse(data) as { ref: StripRef };
                s.update((st) => ({ layers: st.layers.map((x) => (x.id === l.id ? { ...x, slots: addToPage(x.slots, ref) } : x)) }));
              }}
            >
              <span className="page-num">{i + 1}</span>
              <span className="page-name">{l.name}</span>
              <span className="page-preview">
                {l.slots.map((r, j) => (
                  <i key={j} style={{ background: refColor(s, r) ?? 'transparent' }} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      <div className="pages-actions">
        <button
          onClick={() => {
            const id = newId('L');
            setLayers([...s.layers, { id, name: `Page ${s.layers.length + 1}`, slots: Array(LAYER_SLOTS).fill(null) }], id);
            setEditing(true);
          }}
        >
          + New
        </button>
        <button className={editing ? 'on' : ''} onClick={() => setEditing(!editing)}>
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>
      {editing && current && (
        <div className="page-edit">
          <input value={current.name} onChange={(e) => upCurrent({ name: e.target.value })} />
          <ColorPicker value={layerColor(current, s.layers.indexOf(current))} onChange={(color) => upCurrent({ color })} />
          <div className="row wrap">
            <button
              onClick={() => {
                const id = newId('L');
                setLayers([...s.layers, { ...structuredClone(current), id, name: current.name + ' copy' }], id);
              }}
            >
              Duplicate
            </button>
            <button onClick={() => upCurrent({ slots: Array(LAYER_SLOTS).fill(null) })}>Clear</button>
            <button
              disabled={s.layers.length <= 1}
              onClick={() => {
                const idx = s.layers.indexOf(current);
                const rest = s.layers.filter((l) => l.id !== current.id);
                setLayers(rest, rest[Math.max(0, idx - 1)].id);
              }}
            >
              Delete
            </button>
          </div>
          <div className="row">
            <button
              disabled={s.layers.indexOf(current) === 0}
              onClick={() => {
                const n = s.layers.slice();
                const i = n.indexOf(current);
                [n[i - 1], n[i]] = [n[i], n[i - 1]];
                setLayers(n);
              }}
            >
              Move up
            </button>
            <button
              disabled={s.layers.indexOf(current) === s.layers.length - 1}
              onClick={() => {
                const n = s.layers.slice();
                const i = n.indexOf(current);
                [n[i + 1], n[i]] = [n[i], n[i + 1]];
                setLayers(n);
              }}
            >
              Move down
            </button>
          </div>
          <p className="hint">Pick what goes on each fader with the selectors above the strips.</p>
        </div>
      )}
    </div>
  );
}

export function FaderBank({ editing }: { editing: boolean }) {
  const s = useConsole();
  const layer = s.layers.find((l) => l.id === s.currentLayer) ?? s.layers[0];
  const setSlot = (i: number, r: StripRef | null) =>
    s.update((st) => ({
      layers: st.layers.map((l) => (l.id === layer.id ? { ...l, slots: l.slots.map((x, j) => (j === i ? r : x)) } : l)),
    }));
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  return (
    <div className="bank">
      {layer?.slots.map((ref, i) => (
        <div
          key={i}
          className={'bank-slot' + (dragFrom === i ? ' dragging' : '') + (over === i && dragFrom !== i ? ' drop-target' : '')}
          onDragStart={(e) => {
            if (!ref) return e.preventDefault();
            e.dataTransfer.effectAllowed = 'copyMove';
            e.dataTransfer.setData(STRIP_MIME, JSON.stringify({ ref, from: i, layer: layer.id }));
            setDragFrom(i);
          }}
          onDragEnd={() => {
            setDragFrom(null);
            setOver(null);
          }}
          onDragOver={(e) => {
            if (dragFrom === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (over !== i) setOver(i);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragFrom !== null) {
              const from = dragFrom;
              s.update((st) => ({ layers: st.layers.map((l) => (l.id === layer.id ? { ...l, slots: moveSlot(l.slots, from, i) } : l)) }));
            }
            setDragFrom(null);
            setOver(null);
          }}
        >
          {editing && <StripRefSelect className="slot-assign" value={ref} onChange={(r) => setSlot(i, r)} />}
          <Strip refr={ref} index={i} />
        </div>
      ))}
    </div>
  );
}
