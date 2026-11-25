// Fader pages (layers) on the mix surface: a column of big page keys next to the
// faders, like the layer keys on a dLive / LV1 / M32, plus on-surface page editing.

import { createContext, useContext, useState } from 'react';
import { LAYER_SLOTS, newId, PALETTE } from '../core/defaults';
import { setLayout, toggleRack, useUi, type LayoutPref } from './uiState';
import { addToPage, deletePage, focusedLayerId, moveSlot } from '../core/layers';
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

/** Fader travel in px, measured from the available height so faders fill the screen. */
export const FaderHeight = createContext(230);
export const useFaderHeight = () => useContext(FaderHeight);

export function PageKeys({ editing, setEditing }: { editing: boolean; setEditing: (b: boolean) => void }) {
  const layoutPref = useUi((u) => u.layout);
  const rackHidden = useUi((u) => u.rackHidden);
  const s = useConsole();
  const split = s.bankLayout === 'split';
  const focusedId = focusedLayerId(s);
  const current = s.layers.find((l) => l.id === focusedId) ?? s.layers[0];
  const setLayers = (layers: Layer[]) => s.update(() => ({ layers }));
  const showInFocused = (id: string) => s.dispatch({ type: 'layer.select', args: { id } });
  const upCurrent = (p: Partial<Layer>) => setLayers(s.layers.map((l) => (l.id === current.id ? { ...l, ...p } : l)));
  const move = (d: number) => {
    const n = s.layers.slice();
    const i = n.indexOf(current);
    if (i + d < 0 || i + d >= n.length) return;
    [n[i + d], n[i]] = [n[i], n[i + d]];
    setLayers(n);
  };

  return (
    <div className={'pages' + (editing ? ' editing' : '')}>
      <div className="pages-title">PAGES</div>
      <select
        className="layout-select"
        value={layoutPref}
        title="Screen layout. Auto: one bank on a laptop, one bank + the channel panel pinned open on a big screen"
        onChange={(e) => setLayout(e.target.value as LayoutPref)}
      >
        <option value="auto">Auto layout</option>
        <option value="single">1 bank</option>
        <option value="split">2 banks</option>
        <option value="pinned">1 bank + channel</option>
      </select>
      <button className={'rack-toggle' + (rackHidden ? '' : ' on')} onClick={toggleRack} title={rackHidden ? 'Show the plugin rack on the strips' : 'Hide the plugin rack (just mix)'}>
        {rackHidden ? '▸ RACK' : '▾ RACK'}
      </button>
      {split && (
        <div className="seg target" title="Which bank the page keys load into (or just touch a bank)">
          <button className={s.focusBank === 'A' ? 'on a' : ''} onClick={() => s.update(() => ({ focusBank: 'A' }))}>→ A</button>
          <button className={s.focusBank === 'B' ? 'on b' : ''} onClick={() => s.update(() => ({ focusBank: 'B' }))}>→ B</button>
        </div>
      )}
      <div className="pages-nav">
        <button onClick={() => s.dispatch({ type: 'layer.prev', args: {} })} title="Previous page">▲</button>
        <button onClick={() => s.dispatch({ type: 'layer.next', args: {} })} title="Next page">▼</button>
      </div>
      <div className="page-keys">
        {s.layers.map((l, i) => {
          const on = l.id === focusedId;
          const inA = l.id === s.currentLayer;
          const inB = split && l.id === s.currentLayerB;
          const color = layerColor(l, i);
          return (
            <button
              key={l.id}
              className={'page-key' + (on ? ' on' : '') + (!on && (inA || inB) ? ' shown' : '')}
              style={{ ['--pc' as string]: color }}
              onClick={() => showInFocused(l.id)}
              title={`${i < 9 ? `Press ${i + 1} to select. ` : ''}Drop a strip here to add it to this page.`}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(STRIP_MIME)) return;
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
              <span className="page-num">
                {split && inA && <b className="bank-badge a">A</b>}
                {split && inB && <b className="bank-badge b">B</b>}
                {i + 1}
              </span>
              <span className="page-name">{l.name.replace(/-/g, "\u2011") /* keep "1-16" together */}</span>
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
            setLayers([...s.layers, { id, name: `Page ${s.layers.length + 1}`, slots: Array(LAYER_SLOTS).fill(null) }]);
            showInFocused(id);
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
          {split && <span className="hint">Editing bank {s.focusBank}: {current.name}</span>}
          <input value={current.name} onChange={(e) => upCurrent({ name: e.target.value })} />
          <ColorPicker value={layerColor(current, s.layers.indexOf(current))} onChange={(color) => upCurrent({ color })} />
          <div className="row wrap">
            <button
              onClick={() => {
                const id = newId('L');
                setLayers([...s.layers, { ...structuredClone(current), id, name: current.name + ' copy' }]);
                showInFocused(id);
              }}
            >
              Duplicate
            </button>
            <button onClick={() => upCurrent({ slots: Array(LAYER_SLOTS).fill(null) })}>Clear</button>
            <button disabled={s.layers.length <= 1} onClick={() => s.update((st) => deletePage(st, current.id))}>
              Delete
            </button>
          </div>
          <div className="row">
            <button disabled={s.layers.indexOf(current) === 0} onClick={() => move(-1)}>Move up</button>
            <button disabled={s.layers.indexOf(current) === s.layers.length - 1} onClick={() => move(1)}>Move down</button>
          </div>
          <p className="hint">Pick what goes on each fader with the selectors above the strips, or drag strips by their name.</p>
        </div>
      )}
    </div>
  );
}

export function FaderBank({ editing, bank = 'A' }: { editing: boolean; bank?: 'A' | 'B' }) {
  const s = useConsole();
  const split = s.bankLayout === 'split';
  const layerId = bank === 'B' ? s.currentLayerB : s.currentLayer;
  const layer = s.layers.find((l) => l.id === layerId) ?? s.layers[0];
  const focused = !split || s.focusBank === bank;
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  if (!layer) return null;
  const setSlot = (i: number, r: StripRef | null) =>
    s.update((st) => ({
      layers: st.layers.map((l) => (l.id === layer.id ? { ...l, slots: l.slots.map((x, j) => (j === i ? r : x)) } : l)),
    }));
  // In split view, trailing empty slots are hidden so a short page takes less room.
  let count = layer.slots.length;
  if (split && !(editing && focused)) {
    while (count > 1 && !layer.slots[count - 1]) count--;
  }
  const slots = layer.slots.slice(0, count);
  return (
    <div
      className={'bank' + (split ? ' split' : '') + (split && focused ? ' focused' : '')}
      onPointerDownCapture={() => split && !focused && s.update(() => ({ focusBank: bank }))}
    >
      {split && (
        <div className={'bank-label ' + bank.toLowerCase()}>
          <b>{bank}</b> {layer.name}
        </div>
      )}
      {/* a page is 16 faders that share the width (no scrolling): more faders = another page */}
      <div className="bank-strips" style={{ gridTemplateColumns: `repeat(${count}, minmax(${split ? 52 : 0}px, 120px))` }}>
        {slots.map((ref, i) => (
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
            {editing && focused && <StripRefSelect className="slot-assign" value={ref} onChange={(r) => setSlot(i, r)} />}
            <Strip refr={ref} index={i} />
          </div>
        ))}
      </div>
    </div>
  );
}
