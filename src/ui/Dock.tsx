// The bottom dock: the selected strip's settings on the left and its plugins on the right.
// Inside the Merge app the plugin's own GUI is docked here: the engine places it in a native
// layer exactly over the plugin area, using the bounds this component reports.

import { useEffect, useLayoutEffect, useRef } from 'react';
import { getPlugin } from '../core/plugins';
import { useConsole } from '../core/store';
import type { InsertSlot, StripRef } from '../core/types';
import { dockInsert, sendDockBounds, sendNative, undockInsert, useNative } from '../native/bridge';
import { EMBEDDED } from '../native/embedded';
import { Detail, InsertControls } from './Detail';
import { Toggle } from './controls';
import { KeyEditor } from './UserKeys';
import { useUi } from './uiState';

function useStripInserts(sel: StripRef | null): { name: string; inserts: InsertSlot[]; setInserts: (i: InsertSlot[]) => void } | null {
  const s = useConsole();
  if (!sel) return null;
  if (sel.kind === 'channel') {
    const ch = s.channels.find((c) => c.id === sel.id);
    return ch ? { name: ch.name, inserts: ch.inserts, setInserts: (inserts) => s.updateChannel(ch.id, { inserts }) } : null;
  }
  if (sel.kind === 'bus') {
    const b = s.buses.find((x) => x.id === sel.id);
    return b ? { name: b.name, inserts: b.inserts, setInserts: (inserts) => s.updateBus(b.id, { inserts }) } : null;
  }
  if (sel.kind === 'main') return { name: 'Main LR', inserts: s.main.inserts, setInserts: (inserts) => s.updateMain({ inserts }) };
  return null;
}

const insertName = (ins: InsertSlot) => getPlugin(ins.pluginId)?.name ?? ins.pluginName ?? 'Plugin';

/** The native plugin GUI, placed by the engine over this element. */
function DockedGui({ ins }: { ins: InsertSlot }) {
  const area = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const n = useNative((st) => st.inserts[ins.id]);
  const docked = useNative((st) => st.docked);
  const ready = !!n && !n.loading && !n.error;
  const mine = docked?.slotId === ins.id;
  const dockH = useUi((s) => s.dockHeight);

  useEffect(() => {
    if (ready) dockInsert(ins.id);
  }, [ready, ins.id]);
  useEffect(() => () => {
    sendDockBounds(null);
    undockInsert();
  }, []);

  // grow the dock to fit a taller plugin (within reason)
  useEffect(() => {
    if (!mine || !docked) return;
    const want = docked.height + 70;
    const max = Math.round(window.innerHeight * 0.62);
    if (want > dockH) useUi.setState({ dockHeight: Math.min(max, want) });
  }, [mine, docked?.height]);

  // report where the GUI goes whenever the layout moves
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el || !mine) {
      sendDockBounds(null);
      return;
    }
    const report = () => {
      const r = el.getBoundingClientRect();
      sendDockBounds(r.width > 4 && r.height > 4 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    if (area.current) ro.observe(area.current);
    window.addEventListener('resize', report);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [mine, docked?.width, docked?.height]);

  const tooBig = mine && docked && area.current && (docked.width > area.current.clientWidth || docked.height > area.current.clientHeight);
  return (
    <div className="plugin-host" ref={area}>
      {!ready && (
        <div className="plugin-msg">
          {n?.error ?? (n?.loading ? 'Loading — checking licence…' : 'Waiting for the engine…')}
          {n?.retry && <button onClick={() => sendNative({ type: 'insert.retry', slotId: ins.id })}>Retry</button>}
        </div>
      )}
      {ready && !mine && <div className="plugin-msg">Opening plugin…</div>}
      <div
        ref={frame}
        className="plugin-frame"
        style={mine && docked ? { width: Math.min(docked.width, area.current?.clientWidth ?? docked.width), height: Math.min(docked.height, area.current?.clientHeight ?? docked.height) } : { width: 0, height: 0 }}
      />
      {tooBig && <div className="plugin-msg small">This plugin is bigger than the dock: drag the dock taller, or use Pop out.</div>}
    </div>
  );
}

function PluginArea() {
  const sel = useConsole((s) => s.selected);
  const strip = useStripInserts(sel);
  const dockSlot = useUi((s) => s.dockSlot);
  const nativeOn = useNative((st) => st.status === 'connected');
  const dockUnavailable = useNative((st) => !!st.dockUnavailable);
  if (!strip) return <div className="plugin-area"><div className="plugin-msg">Select a channel, bus or the main to see its plugins.</div></div>;
  const active = strip.inserts.find((i) => i.id === dockSlot) ?? strip.inserts[0];
  const setActive = (id: string) => useUi.setState({ dockSlot: id });
  const isNative = active && !active.pluginId.startsWith('builtin.');
  const canDock = EMBEDDED && nativeOn && isNative && !dockUnavailable;
  return (
    <div className="plugin-area">
      <div className="plugin-tabs">
        <span className="hint">{strip.name} rack</span>
        {strip.inserts.map((ins, i) => (
          <button key={ins.id} className={'plugin-tab' + (ins.id === active?.id ? ' on' : '') + (ins.bypass ? ' byp' : '')} onClick={() => setActive(ins.id)}>
            <span className="hint">{i + 1}</span> {insertName(ins)}
          </button>
        ))}
        <div className="spacer" />
        {active && (
          <>
            <Toggle small on={active.bypass} onClick={() => strip.setInserts(strip.inserts.map((x) => (x.id === active.id ? { ...x, bypass: !x.bypass } : x)))}>BYPASS</Toggle>
            {isNative && nativeOn && (
              <button className="icon-btn" title="Open in its own window" onClick={() => sendNative({ type: 'insert.editor', slotId: active.id, open: true })}>
                Pop out ↗
              </button>
            )}
          </>
        )}
      </div>
      {!active ? (
        <div className="plugin-msg">No plugins on {strip.name}. Add one in the RACK tab.</div>
      ) : canDock ? (
        <DockedGui key={active.id} ins={active} />
      ) : (
        <div className="plugin-params">
          <InsertControls ins={active} onParam={(id, v) => strip.setInserts(strip.inserts.map((x) => (x.id === active.id ? { ...x, params: { ...x.params, [id]: v } } : x)))} />
        </div>
      )}
    </div>
  );
}

export function Dock({ editKey, closeKey }: { editKey: string | null; closeKey: () => void }) {
  const { dockOpen, dockHeight } = useUi();
  const sel = useConsole((s) => s.selected);
  const label = useConsole((s) => {
    if (!sel) return 'Nothing selected';
    if (sel.kind === 'channel') return `Ch ${sel.id.slice(2)} · ${s.channels.find((c) => c.id === sel.id)?.name}`;
    if (sel.kind === 'bus') return s.buses.find((b) => b.id === sel.id)?.name ?? '';
    if (sel.kind === 'dca') return s.dcas.find((d) => d.id === sel.id)?.name ?? '';
    return 'Main LR';
  });
  const drag = useRef<{ y: number; h: number } | null>(null);
  return (
    <div className={'dock' + (dockOpen ? '' : ' closed')}>
      <div
        className="dock-head"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, h: dockHeight };
        }}
        onPointerMove={(e) => {
          if (!drag.current || !dockOpen) return;
          const h = Math.max(180, Math.min(window.innerHeight * 0.7, drag.current.h + (drag.current.y - e.clientY)));
          useUi.setState({ dockHeight: Math.round(h) });
        }}
        onPointerUp={() => (drag.current = null)}
        title="Drag to resize"
      >
        <span className="dock-grip">⋯</span>
        <span className="dock-title">{editKey ? 'Edit user key' : label}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={() => useUi.setState({ dockOpen: !dockOpen })}>{dockOpen ? '▾ Hide' : '▴ Show'}</button>
      </div>
      {dockOpen && (
        <div className="dock-body" style={{ height: dockHeight }}>
          <div className="dock-left">{editKey ? <KeyEditor id={editKey} onClose={closeKey} /> : <Detail />}</div>
          <PluginArea />
        </div>
      )}
    </div>
  );
}
