import { useEffect, useRef, useState } from 'react';
import { anySolo } from '../core/mix';
import { useConsole } from '../core/store';
import { getEngine } from '../audio/engine';
import { readNativeLimiter, resetNativeTruePeakHold, sendNative, useNative } from '../native/bridge';
import { Detail } from './Detail';
import { Knob, Meter, Toggle, fmtDb } from './controls';
import { registerLoudness } from './meterLoop';
import { FaderBank, FaderHeight, PageKeys } from './Pages';
import { KeyEditor, UserKeyGrid } from './UserKeys';


function MuteGroupMasters() {
  const s = useConsole();
  return (
    <div className="panel">
      <div className="panel-title">Mute groups</div>
      <div className="mg-masters">
        {s.muteGroups.map((g) => {
          const n = s.channels.filter((c) => c.muteGroups.includes(g.id)).length + s.buses.filter((b) => b.muteGroups.includes(g.id)).length;
          return (
            <button key={g.id} className={'mg-master' + (g.active ? ' on' : '')} onClick={() => s.dispatch({ type: 'muteGroup.toggle', args: { id: g.id } })}>
              <span className="mg-num">{g.id.replace('mg', '')}</span>
              <span className="mg-name">{g.name}</span>
              <span className="hint">{n}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Loudness() {
  const refs = { m: useRef<HTMLSpanElement>(null), s: useRef<HTMLSpanElement>(null), i: useRef<HTMLSpanElement>(null), bar: useRef<HTMLDivElement>(null), tp: useRef<HTMLSpanElement>(null), gr: useRef<HTMLSpanElement>(null) };
  const ceiling = useConsole((s) => s.main.limiter.ceilingDb);
  const native = useNative((st) => st.status === 'connected');
  const target = useConsole((s) => s.loudnessTarget);
  const setTarget = (loudnessTarget: number) => useConsole.getState().update(() => ({ loudnessTarget }));
  useEffect(
    () =>
      registerLoudness((l) => {
        const f = (x: number) => (isFinite(x) ? x.toFixed(1) : '—');
        if (refs.m.current) refs.m.current.textContent = f(l.momentary);
        if (refs.s.current) refs.s.current.textContent = f(l.shortTerm);
        if (refs.i.current) {
          refs.i.current.textContent = f(l.integrated);
          const off = isFinite(l.integrated) ? Math.abs(l.integrated - target) : 0;
          refs.i.current.className = 'lufs-val big ' + (off > 2 ? 'bad' : off > 1 ? 'warn' : 'ok');
        }
        if (refs.tp.current && refs.gr.current) {
          const lim = readNativeLimiter();
          refs.tp.current.textContent = isFinite(lim.tpMaxDb) ? lim.tpMaxDb.toFixed(1) : '—';
          refs.tp.current.className = 'tp-val ' + (lim.tpMaxDb > ceiling + 0.05 ? 'bad' : 'ok');
          refs.gr.current.textContent = lim.grDb < -0.05 ? lim.grDb.toFixed(1) : '0.0';
          refs.gr.current.className = 'tp-val ' + (lim.grDb < -3 ? 'warn' : '');
        }
        if (refs.bar.current) {
          const pct = isFinite(l.shortTerm) ? Math.max(0, Math.min(100, ((l.shortTerm + 50) / 50) * 100)) : 0;
          refs.bar.current.style.width = `${pct}%`;
        }
      }),
    [target, ceiling],
  );
  return (
    <div className="panel loudness">
      <div className="panel-title row between">
        <span>Program loudness</span>
        <select value={target} onChange={(e) => setTarget(Number(e.target.value))}>
          <option value={-11}>Stream, hot (-11)</option>
          <option value={-14}>YouTube ref (-14)</option>
          <option value={-16}>Streaming (-16)</option>
          <option value={-23}>EBU R128 (-23)</option>
          <option value={-24}>ATSC A/85 (-24)</option>
        </select>
      </div>
      <div className="lufs">
        <div><span className="hint">M</span><span ref={refs.m} className="lufs-val">—</span></div>
        <div><span className="hint">S</span><span ref={refs.s} className="lufs-val">—</span></div>
        <div><span className="hint">I</span><span ref={refs.i} className="lufs-val big">—</span><span className="hint">LUFS</span></div>
        <button className="link-btn" onClick={() => { getEngine()?.resetLoudness(); sendNative({ type: 'loudness.reset' }); resetNativeTruePeakHold(); }}>reset</button>
      </div>
      {native && (
        <div className="lufs tp-row" title="True-peak max since reset (dBTP) and program limiter gain reduction">
          <div><span className="hint">TP max</span><span ref={refs.tp} className="tp-val">—</span><span className="hint">dBTP</span></div>
          <div><span className="hint">LIM</span><span ref={refs.gr} className="tp-val">0.0</span><span className="hint">dB</span></div>
        </div>
      )}
      <div className="lufs-bar">
        <div ref={refs.bar} className="lufs-fill" />
        <div className="lufs-target" style={{ left: `${((target + 50) / 50) * 100}%` }} />
      </div>
    </div>
  );
}

function Monitor() {
  const s = useConsole();
  const solo = anySolo(s);
  return (
    <div className="panel monitor">
      <div className="panel-title">Monitor</div>
      <div className="row">
        <Meter id="monitor" height={70} stereo />
        <div className="col">
          <select value={s.monitor.source} onChange={(e) => s.update((st) => ({ monitor: { ...st.monitor, source: e.target.value } }))}>
            <option value="main">Main LR</option>
            {s.buses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <div className="row">
            <Toggle on={s.monitor.dim} onClick={() => s.dispatch({ type: 'monitor.dim', args: {} })} small>DIM</Toggle>
            <Toggle
              on={s.monitor.soloMode === 'afl'}
              onClick={() => s.update((st) => ({ monitor: { ...st.monitor, soloMode: st.monitor.soloMode === 'pfl' ? 'afl' : 'pfl' } }))}
              small
            >
              {s.monitor.soloMode.toUpperCase()}
            </Toggle>
            <Toggle kind="solo" on={solo} onClick={() => s.dispatch({ type: 'solo.clear', args: {} })} small title="Clear solo">
              {solo ? 'CLR SOLO' : 'NO SOLO'}
            </Toggle>
          </div>
          <div className="row">
            <Toggle on={s.talkback.active} onClick={() => s.dispatch({ type: 'talkback.toggle', args: {} })} small>TALK</Toggle>
          </div>
        </div>
        <Knob label="Level" value={s.monitor.levelDb} min={-60} max={10} defaultValue={0} format={fmtDb} onChange={(levelDb) => s.update((st) => ({ monitor: { ...st.monitor, levelDb } }))} />
      </div>
    </div>
  );
}

/** Strip height that isn't fader travel: header, tags, groups, pan, buttons, readout, mute, padding. */
const STRIP_OVERHEAD = 218;

export function MixView() {
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editPages, setEditPages] = useState(false);
  const split = useConsole((s) => s.bankLayout === 'split');
  // Faders grow to fill the height the window gives the bank row.
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowH, setRowH] = useState(440);
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setRowH(entry.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const overhead = STRIP_OVERHEAD + (split ? 22 : 0) + (editPages ? 28 : 0);
  const faderH = Math.round(Math.max(150, Math.min(700, rowH - overhead)));
  return (
    <div className="mix">
      <div className="mix-left">
        <div className="bank-row" ref={rowRef}>
          <FaderHeight.Provider value={faderH}>
            <PageKeys editing={editPages} setEditing={setEditPages} />
            <FaderBank editing={editPages} bank="A" />
            {split && <FaderBank editing={editPages} bank="B" />}
          </FaderHeight.Provider>
        </div>
        <div className="surface">
          <MuteGroupMasters />
          <div className="panel">
            <div className="panel-title row between">
              <span>User keys</span>
              <span className="hint">right-click a key to assign</span>
            </div>
            <UserKeyGrid onEdit={setEditKey} />
          </div>
          <Monitor />
        </div>
      </div>
      <div className="mix-right">
        <Loudness />
        {editKey ? <KeyEditor id={editKey} onClose={() => setEditKey(null)} /> : <Detail />}
      </div>
    </div>
  );
}
