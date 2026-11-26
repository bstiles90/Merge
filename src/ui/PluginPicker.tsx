// Plugin picker: a pop-up list to put a plugin in a rack slot, straight from the strip.
// Filter by format (VST3 / AU / VST / built-in), type to search, grouped by maker.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { listPlugins, type PluginDescriptor } from '../core/plugins';
import { useNative } from '../native/bridge';
import { usePluginsVersion } from './NativePanel';

const fmtLabel = (f: string) => (f === 'builtin' ? 'Built-in' : f.toUpperCase());

export function PluginPicker({ anchor, onPick, onClose, title, onNone, onOpen, current }: {
  anchor: DOMRect;
  onPick: (p: PluginDescriptor) => void;
  onClose: () => void;
  title?: string;
  /** a used slot: "None" removes the plugin */
  onNone?: () => void;
  /** a used slot: open its window */
  onOpen?: () => void;
  /** the plugin in the slot now (marked in the list) */
  current?: string;
}) {
  const version = usePluginsVersion();
  const nativeOn = useNative((st) => st.status === 'connected');
  const [q, setQ] = useState('');
  const [fmt, setFmt] = useState<string>('all');
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.right + 6, top: anchor.top });

  const all = useMemo(() => listPlugins().filter((p) => (nativeOn ? p.native : !p.native)), [version, nativeOn]);
  const formats = useMemo(() => [...new Set(all.map((p) => p.format))].sort(), [all]);
  const groups = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = all.filter((p) => (fmt === 'all' || p.format === fmt) && words.every((w) => `${p.name} ${p.vendor} ${p.category}`.toLowerCase().includes(w)));
    const key = (x: string) => x.toLowerCase();
    const byVendor = new Map<string, PluginDescriptor[]>();
    for (const p of hit) {
      const v = p.vendor || 'Unknown';
      (byVendor.get(v) ?? byVendor.set(v, []).get(v)!).push(p);
    }
    return { count: hit.length, list: [...byVendor.entries()].sort((a, b) => (key(a[0]) < key(b[0]) ? -1 : 1)).map(([v, arr]) => [v, arr.sort((a, b) => (key(a.name) < key(b.name) ? -1 : 1))] as const) };
  }, [all, q, fmt]);

  // keep the pop-up on screen
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = anchor.right + 6, top = anchor.top;
    if (left + r.width > innerWidth - 8) left = Math.max(8, anchor.left - r.width - 6);
    if (top + r.height > innerHeight - 8) top = Math.max(8, innerHeight - r.height - 8);
    setPos({ left, top });
  }, [anchor]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: PointerEvent) => box.current && !box.current.contains(e.target as Node) && onClose();
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);

  let shown = 0;
  const LIMIT = 400;
  return createPortal(
    <div className="plugin-picker" ref={box} style={pos} onClick={(e) => e.stopPropagation()}>
      <div className="pp-head">
        <b>{title ?? 'Add plugin'}</b>
        <span className="hint">{groups.count} of {all.length}</span>
      </div>
      <input autoFocus className="pp-search" placeholder="Search name or maker…" value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && groups.list.length) onPick(groups.list[0][1][0]);
        }} />
      <div className="pp-formats">
        {['all', ...formats].map((f) => (
          <button key={f} className={'chip' + (fmt === f ? ' on' : '')} onClick={() => setFmt(f)}>{f === 'all' ? 'All' : fmtLabel(f)}</button>
        ))}
      </div>
      {(onNone || onOpen) && (
        <div className="pp-slot-actions">
          {onOpen && <button className="pp-item" onClick={onOpen}><span className="pp-name">Open window</span></button>}
          {onNone && <button className="pp-item pp-none" onClick={onNone}><span className="pp-name">None</span><span className="pp-fmt">remove</span></button>}
        </div>
      )}
      <div className="pp-list">
        {!all.length && <div className="hint pp-empty">{nativeOn ? 'No plugins yet: scan for plugins on the I/O page.' : 'Connect the engine to use your VST3 / AU plugins.'}</div>}
        {all.length > 0 && !groups.count && <div className="hint pp-empty">Nothing matches “{q}”.</div>}
        {groups.list.map(([vendor, arr]) => {
          if (shown >= LIMIT) return null;
          return (
            <div key={vendor} className="pp-group">
              <div className="pp-vendor">{vendor}</div>
              {arr.map((p) => {
                if (shown++ >= LIMIT) return null;
                return (
                  <button key={p.id} className={'pp-item' + (p.id === current ? ' on' : '')} onClick={() => onPick(p)} title={`${p.name} · ${p.vendor} · ${fmtLabel(p.format)} · ${p.category}`}>
                    <span className="pp-name">{p.name}</span>
                    <span className="pp-fmt">{fmtLabel(p.format)}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {groups.count > LIMIT && <div className="hint pp-empty">Showing the first {LIMIT}: type to narrow it down.</div>}
      </div>
    </div>,
    document.body,
  );
}
