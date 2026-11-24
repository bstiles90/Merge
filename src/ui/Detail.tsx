import { useState } from 'react';
import { defaultParams, getPlugin, listPlugins } from '../core/plugins';
import { newId, PALETTE } from '../core/defaults';
import { useConsole } from '../core/store';
import type { Channel, InsertSlot, SourceKind } from '../core/types';
import { fmtDb, fmtHz, fmtMs, Knob, Toggle } from './controls';
import { EqCurve } from './EqCurve';
import { useEngineInputs } from './useEngine';
import { sendNative, useNative } from '../native/bridge';
import { usePluginsVersion } from './NativePanel';

const MAX_INSERTS = 4;

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="colors">
      {PALETTE.map((c) => (
        <button key={c} className={'swatch' + (c === value ? ' on' : '')} style={{ background: c }} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

function NativeInsertEditor({ ins }: { ins: InsertSlot }) {
  const n = useNative((st) => st.inserts[ins.id]);
  const connected = useNative((st) => st.status === 'connected');
  const [filter, setFilter] = useState('');
  if (!connected) return <div className="plugin-editor"><span className="hint">Connect the native engine (I/O page) to load this plugin.</span></div>;
  if (!n) return <div className="plugin-editor"><span className="hint">Loading…</span></div>;
  if (n.error) return <div className="plugin-editor"><span className="error">{n.error}</span></div>;
  const shown = n.params.filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase())).slice(0, 40);
  const set = (id: string, value: number) => {
    sendNative({ type: 'insert.param', slotId: ins.id, id, value });
    useNative.setState((st) => ({
      inserts: { ...st.inserts, [ins.id]: { ...n, params: n.params.map((p) => (p.id === id ? { ...p, value } : p)) } },
    }));
  };
  return (
    <div className="plugin-editor native-editor">
      <div className="row wrap">
        <button className={n.editorOpen ? 'on' : ''} onClick={() => sendNative({ type: 'insert.editor', slotId: ins.id, open: !n.editorOpen })}>
          {n.editorOpen ? 'Close plugin window' : 'Open plugin window'}
        </button>
        <span className="hint">latency {n.latency ?? 0} smp · {n.params.length} params</span>
      </div>
      {n.params.length > 8 && <input placeholder="Filter parameters…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      <div className="native-params">
        {shown.map((p) => (
          <label key={p.id} className="native-param">
            <span className="np-name">{p.name}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={p.steps > 1 ? 1 / (p.steps - 1) : 0.001}
              value={p.value}
              onChange={(e) => set(p.id, Number(e.target.value))}
            />
            <span className="np-text">{p.text} {p.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function Inserts({ inserts, onChange }: { inserts: InsertSlot[]; onChange: (i: InsertSlot[]) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  usePluginsVersion();
  const nativeConnected = useNative((st) => st.status === 'connected');
  const errors = useNative((st) => st.inserts);
  const plugins = listPlugins().filter((p) => (nativeConnected ? p.native : !p.native));
  const groups = [...new Set(plugins.map((p) => `${p.format === 'builtin' ? 'Built-in' : p.format.toUpperCase()} · ${p.category}`))].sort();
  return (
    <div className="section">
      <div className="section-title">
        Inserts <span className="hint">{nativeConnected ? 'native host (VST3/AU)' : 'browser effects'} · {MAX_INSERTS} slots</span>
      </div>
      {inserts.map((ins, i) => {
        const desc = getPlugin(ins.pluginId);
        const isNative = !ins.pluginId.startsWith('builtin.');
        const err = errors[ins.id]?.error;
        return (
          <div key={ins.id} className={'insert' + (ins.bypass ? ' bypassed' : '') + (err ? ' error' : '')}>
            <div className="insert-row">
              <span className="insert-idx">{i + 1}</span>
              <button className="insert-name" onClick={() => setOpen(open === ins.id ? null : ins.id)}>
                {desc?.name ?? ins.pluginName ?? ins.pluginId}
                <span className="hint"> {desc ? `${desc.vendor} · ${desc.format.toUpperCase()}` : isNative ? 'VST3 · not loaded' : 'missing'}</span>
              </button>
              <Toggle small on={ins.bypass} onClick={() => onChange(inserts.map((x) => (x.id === ins.id ? { ...x, bypass: !x.bypass } : x)))}>
                BYP
              </Toggle>
              <button className="icon-btn" disabled={i === 0} title="Move up" onClick={() => {
                const n = inserts.slice();
                [n[i - 1], n[i]] = [n[i], n[i - 1]];
                onChange(n);
              }}>↑</button>
              <button className="icon-btn" title="Remove" onClick={() => onChange(inserts.filter((x) => x.id !== ins.id))}>✕</button>
            </div>
            {err && open !== ins.id && <div className="insert-err">{err}</div>}
            {open === ins.id && isNative && <NativeInsertEditor ins={ins} />}
            {open === ins.id && !isNative && desc && (
              <div className="plugin-editor">
                {desc.params.map((p) => (
                  <Knob
                    key={p.id}
                    label={p.name}
                    value={ins.params[p.id] ?? p.default}
                    min={p.min}
                    max={p.max}
                    log={p.scale === 'log'}
                    step={p.step}
                    defaultValue={p.default}
                    format={(v) => `${v >= 100 ? Math.round(v) : v.toFixed(1)}${p.unit ? ' ' + p.unit : ''}`}
                    onChange={(v) =>
                      onChange(inserts.map((x) => (x.id === ins.id ? { ...x, params: { ...x.params, [p.id]: v } } : x)))
                    }
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {inserts.length < MAX_INSERTS && (
        <select
          className="add-insert"
          value=""
          onChange={(e) => {
            const desc = getPlugin(e.target.value);
            if (!desc) return;
            const slot: InsertSlot = { id: newId('ins'), pluginId: desc.id, pluginName: desc.name, bypass: false, params: defaultParams(desc) };
            onChange([...inserts, slot]);
            setOpen(slot.id);
          }}
        >
          <option value="">{plugins.length ? '+ Add plugin…' : nativeConnected ? 'No plugins yet — scan in I/O' : '+ Add plugin…'}</option>
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {plugins
                .filter((p) => `${p.format === 'builtin' ? 'Built-in' : p.format.toUpperCase()} · ${p.category}` === g)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.vendor})
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      )}
    </div>
  );
}

function SourcePicker({ ch }: { ch: Channel }) {
  const s = useConsole();
  const inputs = useEngineInputs();
  const set = (patch: Partial<Channel['source']>) => s.updateChannel(ch.id, { source: { ...ch.source, ...patch } });
  return (
    <div className="row wrap">
      <select value={ch.source.kind} onChange={(e) => set({ kind: e.target.value as SourceKind })}>
        <option value="none">No source</option>
        <option value="input">Live input (interface)</option>
        <option value="tone">Test tone</option>
        <option value="noise">Pink noise</option>
        <option value="speech">Speech sim</option>
      </select>
      {ch.source.kind === 'tone' && (
        <input type="number" value={ch.source.freq} min={20} max={20000} onChange={(e) => set({ freq: Number(e.target.value) })} style={{ width: 70 }} />
      )}
      {ch.source.kind === 'input' && (
        <>
          <select value={ch.source.deviceId ?? ''} onChange={(e) => set({ deviceId: e.target.value })}>
            <option value="">Select device…</option>
            {inputs.devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || d.deviceId.slice(0, 8)}
              </option>
            ))}
          </select>
          <select value={ch.source.deviceChannel ?? 0} onChange={(e) => set({ deviceChannel: Number(e.target.value) })}>
            {Array.from({ length: inputs.channelsFor(ch.source.deviceId) }, (_, i) => (
              <option key={i} value={i}>
                {inputs.channelName(ch.source.deviceId, i)}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}

function ChannelDetail({ ch }: { ch: Channel }) {
  const s = useConsole();
  const up = (p: Partial<Channel>) => s.updateChannel(ch.id, p);
  const band = (i: number, p: Partial<Channel['eq']['bands'][number]>) =>
    up({ eq: { ...ch.eq, bands: ch.eq.bands.map((b, j) => (j === i ? { ...b, ...p } : b)) } });
  return (
    <div className="detail">
      <div className="detail-head" style={{ borderColor: ch.color }}>
        <input className="name-input" value={ch.name} onChange={(e) => up({ name: e.target.value })} />
        <span className="hint">{ch.id.toUpperCase()}</span>
        <ColorPicker value={ch.color} onChange={(color) => up({ color })} />
      </div>

      <div className="section">
        <div className="section-title">Input</div>
        <SourcePicker ch={ch} />
        <div className="row">
          <Knob label="Gain" value={ch.gainDb} min={-24} max={48} defaultValue={0} format={fmtDb} onChange={(gainDb) => up({ gainDb })} />
          <Knob label="Delay" value={ch.delayMs} min={0} max={500} defaultValue={0} format={fmtMs} onChange={(delayMs) => up({ delayMs })} />
          <div className="col">
            <Toggle on={ch.phaseInvert} onClick={() => up({ phaseInvert: !ch.phaseInvert })} small>Ø</Toggle>
            <Toggle kind="rec" on={ch.recArm} onClick={() => up({ recArm: !ch.recArm })} small>REC</Toggle>
          </div>
          <div className="col">
            <Toggle on={ch.inputMode === 'playback'} onClick={() => up({ inputMode: ch.inputMode === 'live' ? 'playback' : 'live' })} small title="Virtual soundcheck: feed this channel from its recorded track">
              {ch.inputMode === 'live' ? 'LIVE' : 'PLAYBK'}
            </Toggle>
            <Toggle kind="safe" on={ch.recallSafe} onClick={() => up({ recallSafe: !ch.recallSafe })} small title="Recall safe: scenes won't change this channel">
              SAFE
            </Toggle>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-title">
          <Toggle small on={ch.hpf.on} onClick={() => up({ hpf: { ...ch.hpf, on: !ch.hpf.on } })}>HPF</Toggle>
          <Toggle small on={ch.gate.on} onClick={() => up({ gate: { ...ch.gate, on: !ch.gate.on } })}>GATE</Toggle>
        </div>
        <div className="row">
          <Knob label="HPF" value={ch.hpf.freq} min={20} max={600} log defaultValue={80} format={fmtHz} onChange={(freq) => up({ hpf: { ...ch.hpf, freq } })} />
          <Knob label="Thresh" value={ch.gate.threshold} min={-80} max={0} defaultValue={-50} format={fmtDb} onChange={(threshold) => up({ gate: { ...ch.gate, threshold } })} color="#46a758" />
          <Knob label="Range" value={ch.gate.rangeDb} min={0} max={80} defaultValue={40} format={fmtDb} onChange={(rangeDb) => up({ gate: { ...ch.gate, rangeDb } })} color="#46a758" />
          <Knob label="Release" value={ch.gate.release} min={10} max={2000} log defaultValue={150} format={fmtMs} onChange={(release) => up({ gate: { ...ch.gate, release } })} color="#46a758" />
        </div>
      </div>

      <div className="section">
        <div className="section-title">
          <Toggle small on={ch.eq.on} onClick={() => up({ eq: { ...ch.eq, on: !ch.eq.on } })}>EQ</Toggle>
          <button className="link-btn" onClick={() => up({ eq: { ...ch.eq, bands: ch.eq.bands.map((b) => ({ ...b, gainDb: 0 })) } })}>flat</button>
        </div>
        <EqCurve eq={ch.eq} hpf={ch.hpf} />
        <div className="eq-bands">
          {ch.eq.bands.map((b, i) => (
            <div key={i} className="eq-band">
              <Knob size={30} label={['LOW', 'LO-MID', 'HI-MID', 'HIGH'][i]} value={b.gainDb} min={-15} max={15} defaultValue={0} format={fmtDb} onChange={(gainDb) => band(i, { gainDb })} color="#ffc53d" />
              <Knob size={26} value={b.freq} min={20} max={20000} log format={fmtHz} onChange={(freq) => band(i, { freq })} color="#ffc53d" />
              {b.type === 'peaking' && <Knob size={22} value={b.q} min={0.2} max={10} log defaultValue={1} format={(v) => `Q${v.toFixed(1)}`} onChange={(q) => band(i, { q })} color="#ffc53d" />}
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="section-title">
          <Toggle small on={ch.comp.on} onClick={() => up({ comp: { ...ch.comp, on: !ch.comp.on } })}>COMP</Toggle>
        </div>
        <div className="row">
          <Knob label="Thresh" value={ch.comp.threshold} min={-60} max={0} defaultValue={-18} format={fmtDb} onChange={(threshold) => up({ comp: { ...ch.comp, threshold } })} color="#f76b15" />
          <Knob label="Ratio" value={ch.comp.ratio} min={1} max={20} log defaultValue={3} format={(v) => `${v.toFixed(1)}:1`} onChange={(ratio) => up({ comp: { ...ch.comp, ratio } })} color="#f76b15" />
          <Knob label="Attack" value={ch.comp.attack} min={0.5} max={200} log defaultValue={10} format={fmtMs} onChange={(attack) => up({ comp: { ...ch.comp, attack } })} color="#f76b15" />
          <Knob label="Release" value={ch.comp.release} min={10} max={1000} log defaultValue={120} format={fmtMs} onChange={(release) => up({ comp: { ...ch.comp, release } })} color="#f76b15" />
          <Knob label="Makeup" value={ch.comp.makeupDb} min={0} max={24} defaultValue={0} format={fmtDb} onChange={(makeupDb) => up({ comp: { ...ch.comp, makeupDb } })} color="#f76b15" />
        </div>
      </div>

      <Inserts inserts={ch.inserts} onChange={(inserts) => up({ inserts })} />

      <div className="section">
        <div className="section-title">Sends</div>
        <div className="sends">
          {s.buses.map((b) => {
            if (b.type === 'mixminus') {
              const included = ch.mainAssign && b.mixMinusExclude !== ch.id;
              return (
                <div key={b.id} className="send mm">
                  <span className="send-name">{b.name}</span>
                  <span className="hint">{included ? 'auto (main mix)' : 'excluded'}</span>
                </div>
              );
            }
            const snd = ch.sends[b.id] ?? { on: false, levelDb: -Infinity, pre: false };
            const setSend = (p: Partial<typeof snd>) => up({ sends: { ...ch.sends, [b.id]: { ...snd, ...p } } });
            return (
              <div key={b.id} className={'send' + (snd.on ? ' on' : '')}>
                <Toggle small on={snd.on} onClick={() => setSend({ on: !snd.on, levelDb: isFinite(snd.levelDb) ? snd.levelDb : 0 })}>
                  {b.name}
                </Toggle>
                <input
                  type="range"
                  min={-60}
                  max={10}
                  step={0.5}
                  value={isFinite(snd.levelDb) ? snd.levelDb : -60}
                  onChange={(e) => setSend({ levelDb: Number(e.target.value) <= -60 ? -Infinity : Number(e.target.value), on: true })}
                />
                <span className="send-db">{isFinite(snd.levelDb) ? fmtDb(snd.levelDb) : '-∞'}</span>
                <Toggle small on={snd.pre} onClick={() => setSend({ pre: !snd.pre })}>PRE</Toggle>
              </div>
            );
          })}
        </div>
        <div className="row">
          <Toggle on={ch.mainAssign} onClick={() => up({ mainAssign: !ch.mainAssign })} small>MAIN LR</Toggle>
        </div>
      </div>

      <div className="section">
        <div className="section-title">Groups</div>
        <div className="chips">
          {s.dcas.map((d) => (
            <button
              key={d.id}
              className={'chip' + (ch.dcas.includes(d.id) ? ' on' : '')}
              style={ch.dcas.includes(d.id) ? { background: d.color } : undefined}
              onClick={() => up({ dcas: ch.dcas.includes(d.id) ? ch.dcas.filter((x) => x !== d.id) : [...ch.dcas, d.id] })}
            >
              {d.name}
            </button>
          ))}
        </div>
        <div className="chips">
          {s.muteGroups.map((g) => (
            <button
              key={g.id}
              className={'chip mg' + (ch.muteGroups.includes(g.id) ? ' on' : '')}
              onClick={() =>
                up({ muteGroups: ch.muteGroups.includes(g.id) ? ch.muteGroups.filter((x) => x !== g.id) : [...ch.muteGroups, g.id] })
              }
            >
              {g.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function BusDetail({ id }: { id: string }) {
  const s = useConsole();
  const b = s.buses.find((x) => x.id === id)!;
  const up = (p: Partial<typeof b>) => s.updateBus(id, p);
  return (
    <div className="detail">
      <div className="detail-head" style={{ borderColor: b.color }}>
        <input className="name-input" value={b.name} onChange={(e) => up({ name: e.target.value })} />
        <span className="hint">{b.id.toUpperCase()}</span>
        <ColorPicker value={b.color} onChange={(color) => up({ color })} />
      </div>
      <div className="section">
        <div className="section-title">Bus type</div>
        <div className="row wrap">
          <select value={b.type} onChange={(e) => up({ type: e.target.value as typeof b.type })}>
            <option value="aux">Aux / IEM / Matrix (sends)</option>
            <option value="mixminus">Mix-minus / N-1 (auto)</option>
          </select>
          {b.type === 'mixminus' && (
            <label className="row">
              minus
              <select value={b.mixMinusExclude ?? ''} onChange={(e) => up({ mixMinusExclude: e.target.value || undefined })}>
                <option value="">(none)</option>
                {s.channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {b.type === 'mixminus' && <p className="hint">Receives the main mix (post-fader) minus the selected source — e.g. a remote guest's return feed so they don't hear themselves delayed.</p>}
        <div className="row">
          <Knob label="Delay" value={b.delayMs} min={0} max={500} defaultValue={0} format={fmtMs} onChange={(delayMs) => up({ delayMs })} />
          <Toggle kind="safe" on={b.recallSafe} onClick={() => up({ recallSafe: !b.recallSafe })} small>SAFE</Toggle>
        </div>
      </div>
      <Inserts inserts={b.inserts} onChange={(inserts) => up({ inserts })} />
      <div className="section">
        <div className="section-title">Mute groups</div>
        <div className="chips">
          {s.muteGroups.map((g) => (
            <button
              key={g.id}
              className={'chip mg' + (b.muteGroups.includes(g.id) ? ' on' : '')}
              onClick={() => up({ muteGroups: b.muteGroups.includes(g.id) ? b.muteGroups.filter((x) => x !== g.id) : [...b.muteGroups, g.id] })}
            >
              {g.name}
            </button>
          ))}
        </div>
      </div>
      <div className="section">
        <div className="section-title">Sends on fader</div>
        <p className="hint">Channels sending to {b.name}:</p>
        <div className="chips">
          {s.channels
            .filter((c) => (b.type === 'mixminus' ? c.mainAssign && c.id !== b.mixMinusExclude && isFinite(c.faderDb) : c.sends[b.id]?.on))
            .map((c) => (
              <span key={c.id} className="chip on" style={{ background: c.color }}>
                {c.name}
              </span>
            ))}
        </div>
      </div>
    </div>
  );
}

function DcaDetail({ id }: { id: string }) {
  const s = useConsole();
  const d = s.dcas.find((x) => x.id === id)!;
  return (
    <div className="detail">
      <div className="detail-head" style={{ borderColor: d.color }}>
        <input className="name-input" value={d.name} onChange={(e) => s.updateDca(id, { name: e.target.value })} />
        <span className="hint">{d.id.toUpperCase()}</span>
        <ColorPicker value={d.color} onChange={(color) => s.updateDca(id, { color })} />
      </div>
      <div className="section">
        <div className="section-title">Members</div>
        <div className="chips">
          {s.channels.map((c) => (
            <button
              key={c.id}
              className={'chip' + (c.dcas.includes(id) ? ' on' : '')}
              style={c.dcas.includes(id) ? { background: c.color } : undefined}
              onClick={() => s.updateChannel(c.id, { dcas: c.dcas.includes(id) ? c.dcas.filter((x) => x !== id) : [...c.dcas, id] })}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function MainDetail() {
  const s = useConsole();
  return (
    <div className="detail">
      <div className="detail-head">
        <span className="name-input">Main LR (Program)</span>
      </div>
      <div className="section">
        <div className="section-title">Program</div>
        <div className="row">
          <Knob label="Lip-sync delay" value={s.main.delayMs} min={0} max={1000} defaultValue={0} format={fmtMs} onChange={(delayMs) => s.updateMain({ delayMs })} />
        </div>
        <p className="hint">Use the delay to line program audio up with a delayed video path.</p>
      </div>
      <Inserts inserts={s.main.inserts} onChange={(inserts) => s.updateMain({ inserts })} />
    </div>
  );
}

export function Detail() {
  const sel = useConsole((s) => s.selected);
  const ch = useConsole((s) => (sel?.kind === 'channel' ? s.channels.find((c) => c.id === sel.id) : undefined));
  if (!sel) return <div className="detail empty">Select a strip</div>;
  if (sel.kind === 'channel' && ch) return <ChannelDetail ch={ch} />;
  if (sel.kind === 'bus') return <BusDetail id={sel.id} />;
  if (sel.kind === 'dca') return <DcaDetail id={sel.id} />;
  if (sel.kind === 'main') return <MainDetail />;
  return null;
}
