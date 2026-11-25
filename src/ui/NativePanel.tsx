import { useState, useSyncExternalStore } from 'react';
import { listPlugins, onPluginsChange, pluginsVersion } from '../core/plugins';
import { connectNative, disconnectNative, sendNative, useNative } from '../native/bridge';
import { getEngine } from '../audio/engine';
import { EMBEDDED } from '../native/embedded';

export function usePluginsVersion() {
  return useSyncExternalStore(onPluginsChange, pluginsVersion);
}

/** Connect / disconnect the native engine; shared by the top bar and the I/O page. */
export async function toggleNative() {
  const st = useNative.getState();
  if (st.status === 'connected' || st.status === 'connecting') {
    disconnectNative();
    await getEngine()?.ctx.resume();
    return;
  }
  try {
    await connectNative();
    // only one engine renders at a time
    await getEngine()?.ctx.suspend();
  } catch {
    /* status/error shown in the UI */
  }
}

export function NativePanel() {
  const n = useNative();
  usePluginsVersion();
  const [path, setPath] = useState('');
  const connected = n.status === 'connected';
  const d = n.device;
  const type = d?.types.find((t) => t.name === d.deviceType) ?? d?.types[0];
  const nativePlugins = listPlugins().filter((p) => p.native);
  const setDevice = (patch: object) => sendNative({ type: 'device.set', deviceType: d?.deviceType ?? type?.name, ...patch });

  return (
    <div className="panel native">
      <div className="panel-title row between">
        <span>Native engine (VST3 / AU host)</span>
        <span className={'status-dot ' + n.status}>{n.status === 'connected' ? `v${n.version ?? '?'} connected` : n.status}</span>
      </div>
      {EMBEDDED ? (
        <p className="hint">Built into this app — always connected.</p>
      ) : (
      <div className="row">
        <input value={n.url} onChange={(e) => useNative.setState({ url: e.target.value })} disabled={connected} style={{ flex: 1 }} />
        <button className={connected ? 'on' : ''} onClick={toggleNative}>
          {connected ? 'Disconnect' : n.status === 'connecting' ? 'Connecting…' : 'Connect'}
        </button>
      </div>
      )}
      {n.error && !EMBEDDED && <p className="error">{n.error}</p>}
      {!connected && !EMBEDDED && (
        <p className="hint">
          Run <code>Merge Engine</code> (built from <code>engine/</code>) on this machine, then connect. The engine does the audio and plugin hosting; this UI stays the
          console. Only one engine renders at a time — the browser engine pauses while the native one is connected.
        </p>
      )}

      {connected && d && (
        <>
          <div className="section-title">Audio device</div>
          {d.virtual && <p className="hint">No audio interface is open — the engine is running on a virtual clock. Pick a device below.</p>}
          <div className="form-grid">
            <label>Driver</label>
            <select value={d.deviceType ?? ''} onChange={(e) => setDevice({ deviceType: e.target.value })}>
              {d.virtual && <option value="">—</option>}
              {d.types.map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
            <label>Input</label>
            <select value={d.inputDevice ?? ''} onChange={(e) => setDevice({ inputDevice: e.target.value })}>
              <option value="">None</option>
              {type?.inputs.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <label>Output</label>
            <select value={d.outputDevice ?? ''} onChange={(e) => setDevice({ outputDevice: e.target.value })}>
              <option value="">None</option>
              {type?.outputs.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <label>Sample rate</label>
            <select value={d.sampleRate} onChange={(e) => setDevice({ sampleRate: Number(e.target.value) })}>
              {(d.sampleRates?.length ? d.sampleRates : [d.sampleRate]).map((r) => <option key={r} value={r}>{r} Hz</option>)}
            </select>
            <label>Buffer</label>
            <select value={d.bufferSize} onChange={(e) => setDevice({ bufferSize: Number(e.target.value) })}>
              {(d.bufferSizes?.length ? d.bufferSizes : [d.bufferSize]).map((b) => <option key={b} value={b}>{b} samples</option>)}
            </select>
          </div>
          <p className="hint">
            {d.inputs.length} in / {d.outputs.length} out
            {d.latencyMs !== undefined && ` · round-trip ≈ ${d.latencyMs.toFixed(1)} ms`}
            {n.pdc > 0 && ` · plugin delay compensation ${n.pdc} samples (${((n.pdc / d.sampleRate) * 1000).toFixed(1)} ms)`}
          </p>

          <div className="section-title">Plugins</div>
          <div className="row wrap">
            <button disabled={n.scanning} onClick={() => sendNative({ type: 'plugins.scan', rescan: false })}>Scan for new plugins</button>
            <button disabled={n.scanning} onClick={() => sendNative({ type: 'plugins.scan', rescan: true })}>Full rescan</button>
            <span className="hint">{nativePlugins.length} effects available</span>
          </div>
          {n.scanning && n.scan && (
            <div className="scan">
              <div className="scan-bar"><div style={{ width: `${Math.round(n.scan.progress * 100)}%` }} /></div>
              <span className="hint">
                {n.scan.format} · {n.scan.file.split(/[\\/]/).pop()}
                {(n.scan.seconds ?? 0) >= 3 && ` · ${n.scan.seconds}s`}
              </span>
              {(n.scan.seconds ?? 0) >= 5 && (
                <button className="small" onClick={() => sendNative({ type: 'plugins.skip' })} title="Give up on this plugin (it's skipped until a full rescan)">
                  Skip this plugin
                </button>
              )}
            </div>
          )}
          <div className="row">
            <input placeholder="Add a plugin file… e.g. /Library/Audio/Plug-Ins/VST3/Foo.vst3" value={path} onChange={(e) => setPath(e.target.value)} style={{ flex: 1 }} />
            <button disabled={!path} onClick={() => { sendNative({ type: 'plugins.addFile', path }); setPath(''); }}>Add</button>
          </div>
          {n.blacklisted.length > 0 && (
            <p className="hint">
              Skipped (didn't finish loading, crashed, or skipped by you): {n.blacklisted.map((f) => f.split(/[\\/]/).pop()).join(', ')}. A full rescan tries them again.
            </p>
          )}
          <div className="plugin-list">
            {nativePlugins.map((p) => (
              <div key={p.id} className="plugin-row">
                <span>{p.name}</span>
                <span className="hint">{p.vendor} · {p.format.toUpperCase()} · {p.category}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
