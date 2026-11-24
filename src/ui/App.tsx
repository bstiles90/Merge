import { useEffect, useRef, useState } from 'react';
import { installHotkeys } from '../control/hotkeys';
import { defaultState } from '../core/defaults';
import { anySolo } from '../core/mix';
import { parseShow, serializeShow, stateOnly, useConsole } from '../core/store';
import { MixView } from './MixView';
import { PatchView } from './PatchView';
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
  ['setup', 'Layers · Keys · Groups'],
  ['io', 'I/O · Patch · MIDI'],
];

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
  const [tab, setTab] = useState<Tab>('mix');
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
        <div className="brand">MERGE</div>
        <input className="show-name" value={s.showName} onChange={(e) => s.update(() => ({ showName: e.target.value }))} />
        <nav className="tabs">
          {TABS.map(([id, label]) => (
            <button key={id} className={'tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="scene-mini" title="Current scene">
          <span className="hint">SCENE</span> {scene?.name ?? '—'}
        </div>
        {anySolo(s) && (
          <button className="solo-flash" onClick={() => s.dispatch({ type: 'solo.clear', args: {} })} title="A channel or bus is soloed — the monitor is on the cue/PFL bus. Click to clear.">
            SOLO
          </button>
        )}
        <TransportMini />
        <div className="file-btns">
          <button onClick={save}>Save show</button>
          <button onClick={() => (EMBEDDED ? sendNative({ type: 'show.open' }) : fileRef.current?.click())}>{EMBEDDED ? 'Open' : 'Load'}</button>
          <button
            className={confirmNew ? 'confirm' : ''}
            title="Start from the default show (unsaved changes are lost)"
            onClick={() => {
              if (!confirmNew) return setConfirmNew(true);
              setConfirmNew(false);
              s.loadShow(defaultState());
              useNative.setState({ showPath: undefined });
            }}
          >
            {confirmNew ? 'Click again to reset' : 'New'}
          </button>
        </div>
        {EMBEDDED ? (
          <span className={'engine-on native' + (native.status === 'connected' ? '' : ' offline')} title={native.showPath ?? ''}>
            {native.status === 'connected' ? `● ENGINE ${native.device ? `${native.device.sampleRate / 1000}k` : ''}` : '○ STARTING…'}
          </span>
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
        {tab === 'io' && <PatchView />}
      </main>
    </div>
  );
}
