import { useEffect, useRef, useState } from 'react';
import { installHotkeys } from '../control/hotkeys';
import { defaultState } from '../core/defaults';
import { anySolo } from '../core/mix';
import { parseShow, serializeShow, stateOnly, useConsole } from '../core/store';
import { MixView } from './MixView';
import { IOView } from './IOView';
import { ScenesView } from './ScenesView';
import { SetupView } from './SetupView';
import { fmtTime, TimelineView } from './TimelineView';
import { services } from '../core/services';
import { bootEngine, useEngine } from './useEngine';
import { sendNative, startEmbedded, useNative } from '../native/bridge';
import { EMBEDDED } from '../native/embedded';
import { toggleNative } from './NativePanel';

type Tab = 'mix' | 'timeline' | 'scenes' | 'setup' | 'io';
const TABS: [Tab, string][] = [
  ['mix', 'Mix'],
  ['timeline', 'Record / Timeline'],
  ['scenes', 'Scenes'],
  ['setup', 'Setup'],
  ['io', 'I/O'],
];

const TAB_HINTS: Partial<Record<Tab, string>> = { setup: 'Fader pages (layers), user keys, mute groups, DCAs, metering', io: 'Channel names, inputs and routing; buses; output patch; devices, plugins, MIDI' };

/** Workspaces share one show and engine; each shows the pages for that job. */
type Workspace = 'live' | 'studio' | 'record';
const WORKSPACES: { id: Workspace; label: string; tabs: Tab[]; ready: boolean; about: string }[] = [
  { id: 'live', label: 'Live', tabs: ['mix', 'scenes', 'setup', 'io'], ready: true, about: 'Mix the service: faders, scenes, I/O and routing' },
  { id: 'studio', label: 'Studio', tabs: [], ready: false, about: 'Coming later' },
  { id: 'record', label: 'Record', tabs: ['timeline', 'io'], ready: true, about: 'Record and play back: timeline, transport' },
];

/** Engine status dot + sample rate; click for a quick audio menu (rate, buffer, device). */
function EngineMenu({ onAudioSettings }: { onAudioSettings: () => void }) {
  const native = useNative();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  const d = native.device;
  const on = native.status === 'connected';
  const rates = d?.sampleRates?.length ? d.sampleRates : d ? [d.sampleRate] : [];
  const fmtRate = (r: number) => (r % 1000 ? `${(r / 1000).toFixed(1)}k` : `${r / 1000}k`);
  const set = (patch: object) => sendNative({ type: 'device.set', deviceType: d?.deviceType, ...patch });
  return (
    <div className="engine-wrap" ref={ref}>
      <button className={'engine-on native' + (on ? '' : ' offline') + (open ? ' open' : '')} onClick={() => setOpen(!open)} title="Audio engine: sample rate, buffer, device">
        <i className="eng-dot" />
        {on ? (d ? fmtRate(d.sampleRate) : 'ON') : 'Starting…'}
      </button>
      {open && (
        <div className="show-menu engine-menu" role="menu">
          <div className="ws-menu-title">Audio engine</div>
          {!d || d.virtual ? (
            <div className="show-menu-info"><span className="hint">No audio device open.</span></div>
          ) : (
            <>
              <div className="show-menu-info">
                <div><b>{d.outputDevice || d.inputDevice || d.deviceType}</b></div>
                {d.inputDevice && d.inputDevice !== d.outputDevice && <div className="hint">In: {d.inputDevice}</div>}
              </div>
              <div className="menu-label">Sample rate</div>
              <div className="rate-row">
                {[44100, 48000, 96000].map((r) => {
                  const ok = rates.includes(r);
                  return (
                    <button
                      key={r}
                      className={'rate-btn' + (d.sampleRate === r ? ' on' : '')}
                      disabled={!ok}
                      title={ok ? `Run at ${fmtRate(r)}Hz (audio stops for a moment while the device restarts)` : `${d.outputDevice || 'This device'} doesn't offer ${fmtRate(r)}Hz`}
                      onClick={() => d.sampleRate !== r && set({ sampleRate: r })}
                    >
                      {fmtRate(r)}
                    </button>
                  );
                })}
              </div>
              <div className="menu-label">Buffer</div>
              <select className="buffer-select" value={d.bufferSize} onChange={(e) => set({ bufferSize: Number(e.target.value) })}>
                {(d.bufferSizes?.length ? d.bufferSizes : [d.bufferSize]).map((b) => (
                  <option key={b} value={b}>
                    {b} samples ({((b / d.sampleRate) * 1000).toFixed(1)} ms)
                  </option>
                ))}
              </select>
              <div className="hint engine-note">Changing these restarts the audio device for a moment: do it before the service, not during.</div>
            </>
          )}
          <button className="menu-item" onClick={() => { setOpen(false); onAudioSettings(); }}>Audio settings…</button>
        </div>
      )}
    </div>
  );
}

/** The wordmark is the workspace switcher: MERGE | LIVE ▾ (click the workspace name to change it). */
function WorkspaceSwitcher({ current, onChoose }: { current: Workspace; onChoose: (w: (typeof WORKSPACES)[number]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const ws = WORKSPACES.find((w) => w.id === current)!;
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className="brand" ref={ref}>
      <span className="brand-word">MERGE</span>
      <span className="brand-sep" />
      <button className={'brand-ws' + (open ? ' open' : '')} aria-haspopup="menu" aria-expanded={open} title="Change workspace" onClick={() => setOpen(!open)}>
        {ws.label.toUpperCase()}
        <span className="brand-caret">▾</span>
      </button>
      {open && (
        <div className="ws-menu" role="menu">
          <div className="ws-menu-title">Workspace</div>
          {WORKSPACES.map((w) => (
            <button
              key={w.id}
              role="menuitemradio"
              aria-checked={w.id === current}
              className={'ws-item' + (w.id === current ? ' on' : '')}
              disabled={!w.ready}
              onClick={() => {
                onChoose(w);
                setOpen(false);
              }}
            >
              <span className="ws-item-name">{w.label.toUpperCase()}</span>
              <span className="ws-item-about">{w.about}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
const loadWorkspace = (): Workspace => {
  try {
    const v = localStorage.getItem('merge.workspace');
    return v === 'record' ? 'record' : 'live';
  } catch {
    return 'live';
  }
};

function TransportMini() {
  const t = useConsole((s) => s.transport);
  const dispatch = useConsole((s) => s.dispatch);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (ref.current) ref.current.textContent = fmtTime(services.playhead());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="transport-mini">
      <span ref={ref} className="tl-time">00:00.00</span>
      <button className={t.playing && !t.recording ? 'on' : ''} onClick={() => dispatch({ type: 'transport.toggle', args: {} })} title="Space">
        {t.playing ? '■' : '▶'}
      </button>
      <button className={'rec-btn' + (t.recording ? ' on' : '')} onClick={() => dispatch({ type: 'transport.record', args: {} })}>●</button>
    </div>
  );
}

export function App() {
  const [workspace, setWorkspace] = useState<Workspace>(loadWorkspace);
  const ws = WORKSPACES.find((w) => w.id === workspace)!;
  const [tab, setTab] = useState<Tab>(() => ws.tabs[0]);
  const chooseWorkspace = (w: (typeof WORKSPACES)[number]) => {
    if (!w.ready) return;
    setWorkspace(w.id);
    if (!w.tabs.includes(tab)) setTab(w.tabs[0]);
    try {
      localStorage.setItem('merge.workspace', w.id);
    } catch {
      /* storage unavailable */
    }
  };
  const engine = useEngine();
  const native = useNative();
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState('');
  const s = useConsole();
  const fileRef = useRef<HTMLInputElement>(null);
  const scene = s.scenes.find((x) => x.id === s.currentScene);

  useEffect(() => installHotkeys(), []);
  useEffect(() => startEmbedded(), []);

  const start = async () => {
    setStarting(true);
    setErr('');
    try {
      await bootEngine();
    } catch (e) {
      setErr(String(e));
    } finally {
      setStarting(false);
    }
  };

  const [confirmNew, setConfirmNew] = useState(false);
  const [showOpen, setShowOpen] = useState(false);
  const showRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showOpen) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !showRef.current?.contains(e.target as Node)) {
        setShowOpen(false);
        setConfirmNew(false);
      }
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close);
    };
  }, [showOpen]);
  useEffect(() => {
    if (!confirmNew) return;
    const t = setTimeout(() => setConfirmNew(false), 3000);
    return () => clearTimeout(t);
  }, [confirmNew]);
  useEffect(() => {
    if (!native.notice) return;
    const t = setTimeout(() => useNative.setState({ notice: undefined }), 4000);
    return () => clearTimeout(t);
  }, [native.notice]);

  const save = () => {
    if (EMBEDDED) {
      sendNative({ type: 'show.saveAs', name: s.showName, text: serializeShow(stateOnly(useConsole.getState())) });
      return;
    }
    const blob = new Blob([serializeShow(stateOnly(useConsole.getState()))], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${s.showName.replace(/[^\w-]+/g, '_') || 'show'}.merge.json`;
    a.click();
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="tb-left">
          <WorkspaceSwitcher current={workspace} onChoose={chooseWorkspace} />
        </div>
        <nav className="tabs" aria-label="View">
          {ws.tabs.map((id) => [id, TABS.find((t) => t[0] === id)![1]] as const).map(([id, label]) => (
            <button key={id} className={'tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)} title={TAB_HINTS[id]}>
              {label}
            </button>
          ))}
        </nav>
        <div className="tb-right">
        {anySolo(s) && (
          <button className="solo-flash" onClick={() => s.dispatch({ type: 'solo.clear', args: {} })} title="A channel or bus is soloed — the monitor is on the cue/PFL bus. Click to clear.">
            SOLO
          </button>
        )}
        {/* Record / Studio: transport and timecode (Live shows the scene in the show chip) */}
        {workspace !== 'live' && <TransportMini />}
        <div className="show-chip-wrap" ref={showRef}>
          <button className={'show-chip' + (showOpen ? ' open' : '')} onClick={() => setShowOpen(!showOpen)} title={native.showPath ?? 'Show: name, save, open, new'} aria-haspopup="menu" aria-expanded={showOpen}>
            <span className="show-chip-text">
              <span className="show-chip-name">{s.showName || 'Untitled show'}</span>
              <span className="show-chip-sub">Scene · {scene?.name ?? 'none'}</span>
            </span>
            <span className="brand-caret">▾</span>
          </button>
          {showOpen && (
            <div className="show-menu" role="menu">
              <div className="ws-menu-title">Show</div>
              <input className="show-name-edit" value={s.showName} onChange={(e) => s.update(() => ({ showName: e.target.value }))} aria-label="Show name" placeholder="Show name" />
              <div className="show-menu-info">
                <span className="hint">Scene</span> <b>{scene?.name ?? 'none'}</b>
                {native.showPath && <div className="hint show-path">{native.showPath}</div>}
              </div>
              <button className="menu-item" onClick={() => { save(); setShowOpen(false); }}>Save show</button>
              <button className="menu-item" onClick={() => { setShowOpen(false); EMBEDDED ? sendNative({ type: 'show.open' }) : fileRef.current?.click(); }}>{EMBEDDED ? 'Open show…' : 'Load show…'}</button>
              <button
                className={'menu-item' + (confirmNew ? ' danger' : '')}
                title="Start from the default show (unsaved changes are lost)"
                onClick={() => {
                  if (!confirmNew) return setConfirmNew(true);
                  setConfirmNew(false);
                  setShowOpen(false);
                  s.loadShow(defaultState());
                  useNative.setState({ showPath: undefined });
                }}
              >
                {confirmNew ? 'Click again to start a new show' : 'New show'}
              </button>
            </div>
          )}
        </div>
        {EMBEDDED ? (
          <EngineMenu onAudioSettings={() => setTab('io')} />
        ) : native.status === 'connected' ? (
          <button className="engine-on native" onClick={toggleNative} title={`Native engine at ${native.url} — click to disconnect`}>
            ● NATIVE {native.device ? `${native.device.sampleRate / 1000}k` : ''}
          </button>
        ) : (
          <>
            {engine ? (
              <span className="engine-on" title={`${engine.ctx.sampleRate} Hz`}>● BROWSER ENGINE</span>
            ) : (
              <button className="engine-start" onClick={start} disabled={starting}>
                {starting ? 'Starting…' : 'Start audio'}
              </button>
            )}
            <button onClick={toggleNative} title="Connect to Merge Engine (native audio + VST3/AU hosting)">
              {native.status === 'connecting' ? 'Connecting…' : 'Connect engine'}
            </button>
          </>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              s.loadShow(parseShow(await f.text()));
            } catch (er) {
              useNative.setState({ notice: `Could not load show: ${er}` });
            }
          }}
        />
      </div>
      </header>
      {err && <div className="error-bar">Audio engine failed to start: {err}</div>}
      {native.notice && <div className="notice-bar">{native.notice}</div>}
      {!EMBEDDED && native.status === 'error' && <div className="error-bar">{native.error}</div>}
      {!EMBEDDED && !engine && native.status !== 'connected' && <div className="engine-hint">Audio is off — the console is fully usable, but click <b>Start audio</b> for the browser engine, or <b>Connect engine</b> for native audio with VST3/AU plugins.</div>}
      <main className="content">
        {tab === 'mix' && <MixView />}
        {tab === 'timeline' && <TimelineView />}
        {tab === 'scenes' && <ScenesView />}
        {tab === 'setup' && <SetupView />}
        {tab === 'io' && <IOView />}
      </main>
    </div>
  );
}
