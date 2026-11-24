import { useEffect, useState } from 'react';
import { useConsole } from '../core/store';
import type { OutputSource, StripRef } from '../core/types';
import { enableMidi, midiStatus, onMidiChange, startLearn } from '../control/midi';
import { Toggle } from './controls';
import { useEngine, useEngineInputs } from './useEngine';

function DevicesPanel() {
  const engine = useEngine();
  const { devices, outputs } = useEngineInputs();
  const s = useConsole();
  const [err, setErr] = useState('');
  return (
    <div className="panel">
      <div className="panel-title">Audio interfaces &amp; network audio</div>
      {engine ? (
        <p className="hint">
          Engine: {engine.ctx.sampleRate} Hz · base latency {(engine.ctx.baseLatency * 1000).toFixed(1)} ms · output channels {engine.outputChannels}/{engine.maxOutputChannels}
        </p>
      ) : (
        <p className="hint">Start the audio engine (top bar) to open devices.</p>
      )}
      <div className="section-title">Inputs</div>
      <table className="list">
        <tbody>
          {devices.length === 0 && (
            <tr>
              <td className="hint">No inputs listed yet — click “Allow input access”.</td>
            </tr>
          )}
          {devices.map((d) => {
            const open = engine?.openInputs.get(d.deviceId);
            return (
              <tr key={d.deviceId}>
                <td>{d.label || `Input ${d.deviceId.slice(0, 6)}`}</td>
                <td className="hint">{open ? `${open.channels} ch open` : ''}</td>
                <td>
                  <button disabled={!engine || !!open} onClick={() => engine?.getInput(d.deviceId)}>
                    {open ? 'Opened' : 'Open'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row">
        <button
          disabled={!engine}
          onClick={async () => {
            try {
              setErr('');
              await engine!.getInput('default');
            } catch (e) {
              setErr(String(e));
            }
          }}
        >
          Allow input access
        </button>
        {err && <span className="error">{err}</span>}
      </div>
      <div className="section-title">Output device</div>
      <select
        value={s.io.outputDeviceId ?? ''}
        disabled={!engine}
        onChange={async (e) => {
          const id = e.target.value || undefined;
          s.update((st) => ({ io: { ...st.io, outputDeviceId: id } }));
          try {
            await engine?.setOutputDevice(id);
          } catch (er) {
            setErr(String(er));
          }
        }}
      >
        <option value="">System default</option>
        {outputs.map((o) => (
          <option key={o.deviceId} value={o.deviceId}>
            {o.label || o.deviceId.slice(0, 8)}
          </option>
        ))}
      </select>
      <div className="note">
        <b>Dante:</b> Dante Virtual Soundcard and Dante-enabled interfaces (Focusrite RedNet, Yamaha, etc.) appear here as normal
        CoreAudio / WASAPI devices — patch Dante flows to them in Dante Controller, then patch their channels to console inputs below.
        <br />
        <b>Waves SoundGrid:</b> the SoundGrid driver (via SoundGrid Studio) appears the same way.
        <br />
        Browsers may limit how many channels they open per device. The native build talks to ASIO/CoreAudio directly for full channel counts and lower latency.
      </div>
    </div>
  );
}

function InputPatch() {
  const s = useConsole();
  const { devices, channelsFor } = useEngineInputs();
  const [bulk, setBulk] = useState({ deviceId: '', from: 1, to: 1, count: 8 });
  return (
    <div className="panel">
      <div className="panel-title">Input patch</div>
      <div className="row wrap">
        <span className="hint">Bulk patch</span>
        <select value={bulk.deviceId} onChange={(e) => setBulk({ ...bulk, deviceId: e.target.value })}>
          <option value="">device…</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || d.deviceId.slice(0, 8)}
            </option>
          ))}
        </select>
        in
        <input type="number" min={1} value={bulk.from} onChange={(e) => setBulk({ ...bulk, from: Number(e.target.value) })} style={{ width: 50 }} />
        → ch
        <input type="number" min={1} max={32} value={bulk.to} onChange={(e) => setBulk({ ...bulk, to: Number(e.target.value) })} style={{ width: 50 }} />
        ×
        <input type="number" min={1} max={32} value={bulk.count} onChange={(e) => setBulk({ ...bulk, count: Number(e.target.value) })} style={{ width: 50 }} />
        <button
          disabled={!bulk.deviceId}
          onClick={() =>
            s.update((st) => ({
              channels: st.channels.map((c, i) => {
                const k = i + 1 - bulk.to;
                if (k < 0 || k >= bulk.count) return c;
                return { ...c, source: { ...c.source, kind: 'input', deviceId: bulk.deviceId, deviceChannel: bulk.from - 1 + k } };
              }),
            }))
          }
        >
          Patch
        </button>
      </div>
      <div className="patch-list">
        {s.channels.map((c) => (
          <div key={c.id} className="patch-row">
            <span className="dot" style={{ background: c.color }} />
            <span className="patch-ch">{c.id.replace('ch', '')}</span>
            <span className="patch-name">{c.name}</span>
            <select
              value={c.source.kind === 'input' ? `in:${c.source.deviceId}:${c.source.deviceChannel ?? 0}` : c.source.kind}
              onChange={(e) => {
                const v = e.target.value;
                if (v.startsWith('in:')) {
                  const [, deviceId, ch] = v.split(':');
                  s.updateChannel(c.id, { source: { ...c.source, kind: 'input', deviceId, deviceChannel: Number(ch) } });
                } else s.updateChannel(c.id, { source: { ...c.source, kind: v as typeof c.source.kind } });
              }}
            >
              <option value="none">—</option>
              <option value="tone">Test tone</option>
              <option value="noise">Pink noise</option>
              <option value="speech">Speech sim</option>
              {devices.map((d) => (
                <optgroup key={d.deviceId} label={d.label || d.deviceId.slice(0, 8)}>
                  {Array.from({ length: channelsFor(d.deviceId) }, (_, i) => (
                    <option key={i} value={`in:${d.deviceId}:${i}`}>
                      In {i + 1}
                    </option>
                  ))}
                </optgroup>
              ))}
              {c.source.kind === 'input' && !devices.find((d) => d.deviceId === c.source.deviceId) && (
                <option value={`in:${c.source.deviceId}:${c.source.deviceChannel ?? 0}`}>(offline device) In {(c.source.deviceChannel ?? 0) + 1}</option>
              )}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

function OutputPatch() {
  const s = useConsole();
  const engine = useEngine();
  const max = engine?.maxOutputChannels ?? 2;
  const n = Math.max(2, Math.min(64, Math.max(max, s.io.outputPatch.length)));
  const value = (o: OutputSource | null | undefined) => (o ? `${o.src}:${o.side}` : '');
  const set = (i: number, v: string) =>
    s.update((st) => {
      const patch = st.io.outputPatch.slice();
      while (patch.length <= i) patch.push(null);
      if (!v) patch[i] = null;
      else {
        const [src, side] = v.split(':');
        patch[i] = { src, side: Number(side) as 0 | 1 };
      }
      return { io: { ...st.io, outputPatch: patch } };
    });
  const sources = [{ id: 'monitor', name: 'Monitor (CR)' }, { id: 'main', name: 'Main LR (PGM)' }, ...s.buses.map((b) => ({ id: b.id, name: b.name }))];
  return (
    <div className="panel">
      <div className="panel-title">Output patch</div>
      <p className="hint">The interface reports {max} output channel{max === 1 ? '' : 's'}. Outputs beyond that are kept in the show file for when a larger interface is connected.</p>
      <div className="patch-list">
        {Array.from({ length: n }, (_, i) => (
          <div key={i} className={'patch-row' + (i >= max ? ' offline' : '')}>
            <span className="patch-ch">Out {i + 1}</span>
            <select value={value(s.io.outputPatch[i])} onChange={(e) => set(i, e.target.value)}>
              <option value="">—</option>
              {sources.map((src) => (
                <optgroup key={src.id} label={src.name}>
                  <option value={`${src.id}:0`}>{src.name} L</option>
                  <option value={`${src.id}:1`}>{src.name} R</option>
                </optgroup>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

function TalkbackPanel() {
  const s = useConsole();
  const { devices, channelsFor } = useEngineInputs();
  const tb = s.talkback;
  const up = (p: Partial<typeof tb>) => s.update((st) => ({ talkback: { ...st.talkback, ...p } }));
  return (
    <div className="panel">
      <div className="panel-title">Talkback</div>
      <div className="row wrap">
        <select value={tb.deviceId ?? ''} onChange={(e) => up({ deviceId: e.target.value || undefined })}>
          <option value="">Talkback mic…</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || d.deviceId.slice(0, 8)}
            </option>
          ))}
        </select>
        <select value={tb.deviceChannel} onChange={(e) => up({ deviceChannel: Number(e.target.value) })}>
          {Array.from({ length: channelsFor(tb.deviceId) }, (_, i) => (
            <option key={i} value={i}>
              In {i + 1}
            </option>
          ))}
        </select>
        <Toggle on={tb.active} onClick={() => up({ active: !tb.active })}>TALK</Toggle>
      </div>
      <div className="chips">
        {s.buses.map((b) => (
          <button
            key={b.id}
            className={'chip' + (tb.destinations.includes(b.id) ? ' on' : '')}
            onClick={() => up({ destinations: tb.destinations.includes(b.id) ? tb.destinations.filter((x) => x !== b.id) : [...tb.destinations, b.id] })}
          >
            {b.name}
          </button>
        ))}
      </div>
      <p className="hint">Talkback dims the control-room monitor by 20 dB while active.</p>
    </div>
  );
}

function MidiPanel() {
  const s = useConsole();
  const [, force] = useState(0);
  useEffect(() => onMidiChange(() => force((x) => x + 1)), []);
  const st = midiStatus();
  const [target, setTarget] = useState('channel:ch1');
  const toRef = (v: string): StripRef => (v === 'main' ? { kind: 'main' } : { kind: v.split(':')[0] as 'channel', id: v.split(':')[1] });
  const label = (r: StripRef) =>
    r.kind === 'main' ? 'Main' : r.kind === 'channel' ? s.channels.find((c) => c.id === r.id)?.name : r.kind === 'bus' ? s.buses.find((c) => c.id === r.id)?.name : s.dcas.find((c) => c.id === r.id)?.name;
  return (
    <div className="panel">
      <div className="panel-title">MIDI control surfaces</div>
      {!st.available ? (
        <p className="hint">Web MIDI is not available in this browser (use Chrome or Edge).</p>
      ) : !st.enabled ? (
        <button onClick={() => enableMidi().then(() => force((x) => x + 1))}>Enable MIDI</button>
      ) : (
        <>
          <p className="hint">Inputs: {st.inputs.join(', ') || 'none connected'}</p>
          <div className="row wrap">
            <span className="hint">Fader learn</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {s.channels.map((c) => (
                <option key={c.id} value={`channel:${c.id}`}>{c.name}</option>
              ))}
              {s.buses.map((b) => (
                <option key={b.id} value={`bus:${b.id}`}>{b.name}</option>
              ))}
              {s.dcas.map((d) => (
                <option key={d.id} value={`dca:${d.id}`}>{d.name}</option>
              ))}
              <option value="main">Main</option>
            </select>
            <button className={st.learning ? 'learning' : ''} onClick={() => startLearn(st.learning ? null : { kind: 'fader', target: toRef(target) })}>
              {st.learning ? 'Move a fader/knob…' : 'Learn'}
            </button>
          </div>
          <table className="list">
            <tbody>
              {s.midiFaders.map((m, i) => (
                <tr key={i}>
                  <td>{label(m.target)}</td>
                  <td>
                    <code>CC {m.data1} ch{(m.status & 0x0f) + 1}</code>
                  </td>
                  <td>
                    <button className="icon-btn" onClick={() => s.update((x) => ({ midiFaders: x.midiFaders.filter((_, j) => j !== i) }))}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">Fader positions are echoed back so motorised faders follow scene recalls and DCA moves. User keys learn MIDI in the key editor.</p>
        </>
      )}
    </div>
  );
}

export function PatchView() {
  return (
    <div className="page grid3">
      <div className="col">
        <DevicesPanel />
        <TalkbackPanel />
        <MidiPanel />
      </div>
      <InputPatch />
      <OutputPatch />
    </div>
  );
}
