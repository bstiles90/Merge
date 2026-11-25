import { useMemo, useState } from 'react';
import { defaultParams, getPlugin, listPlugins } from '../core/plugins';
import { newId, PALETTE } from '../core/defaults';
import { useConsole } from '../core/store';
import { createsLoop } from '../core/plan';
import type { Channel, InsertSlot, SourceKind } from '../core/types';
import { fmtMs, Knob, Toggle } from './controls';
import { ChannelPanel } from './ChannelPanel';
import { useEngineInputs } from './useEngine';
import { sendNative, useNative } from '../native/bridge';
import { usePluginsVersion } from './NativePanel';
import { PluginPicker } from './PluginPicker';
import { MonoStereoSwitch } from './Strip';
import { createLink, linkInfo, naturalPartner, removeLink, setLinkOption, type LinkOption } from '../core/links';

const MAX_INSERTS = 8;

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
  if (!n || n.loading)
    return (
      <div className="plugin-editor">
        <span className="hint">
          Loading{n?.loading ? ' — checking licence' : '…'}. If the plugin needs activation (iLok, Waves, NI…), its window opens on the engine computer.
        </span>
      </div>
    );
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

/** Controls for one insert: the native plugin's parameters, or a built-in effect's knobs. */
export function InsertControls({ ins, onParam }: { ins: InsertSlot; onParam: (id: string, v: number) => void }) {
  if (!ins.pluginId.startsWith('builtin.')) return <NativeInsertEditor ins={ins} />;
  const desc = getPlugin(ins.pluginId);
  if (!desc) return null;
  return (
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
          onChange={(v) => onParam(p.id, v)}
        />
      ))}
    </div>
  );
}

export function Inserts({ inserts, onChange }: { inserts: InsertSlot[]; onChange: (i: InsertSlot[]) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [picker, setPicker] = useState<DOMRect | null>(null);
  const version = usePluginsVersion();
  const nativeConnected = useNative((st) => st.status === 'connected');
  const errors = useNative((st) => st.inserts);
  const plugins = useMemo(() => listPlugins().filter((p) => (nativeConnected ? p.native : !p.native)), [version, nativeConnected]);
  return (
    <div className="section">
      <div className="section-title">
        Inserts <span className="hint">{nativeConnected ? 'native host (VST3/AU)' : 'browser effects'} · {MAX_INSERTS} slots</span>
      </div>
      {inserts.map((ins, i) => {
        const desc = getPlugin(ins.pluginId);
        const isNative = !ins.pluginId.startsWith('builtin.');
        const err = errors[ins.id]?.error;
        const loading = errors[ins.id]?.loading;
        return (
          <div key={ins.id} className={'insert' + (ins.bypass ? ' bypassed' : '') + (err ? ' error' : '')}>
            <div className="insert-row">
              <span className="insert-idx">{i + 1}</span>
              <button className="insert-name" onClick={() => setOpen(open === ins.id ? null : ins.id)}>
                {desc?.name ?? ins.pluginName ?? ins.pluginId}
                <span className="hint"> {loading ? 'loading…' : desc ? `${desc.vendor} · ${desc.format.toUpperCase()}` : isNative ? 'VST3 · not loaded' : 'missing'}</span>
              </button>
              {isNative && nativeConnected && desc && (
                <Toggle small on={!!errors[ins.id]?.editorOpen} title="Open or close the plugin's own window" onClick={() => sendNative({ type: 'insert.editor', slotId: ins.id, open: !errors[ins.id]?.editorOpen })}>
                  WIN
                </Toggle>
              )}
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
            {open === ins.id && (
              <InsertControls ins={ins} onParam={(id, v) => onChange(inserts.map((x) => (x.id === ins.id ? { ...x, params: { ...x.params, [id]: v } } : x)))} />
            )}
          </div>
        );
      })}
      {inserts.length < MAX_INSERTS && (
        <button
          className="add-insert"
          onClick={(e) => setPicker((e.currentTarget as HTMLElement).getBoundingClientRect())}
        >
          {plugins.length || !nativeConnected ? '+ Add plugin…' : 'No plugins yet — scan in I/O'}
        </button>
      )}
      {picker && (
        <PluginPicker
          anchor={picker}
          onClose={() => setPicker(null)}
          onPick={(desc) => {
            setPicker(null);
            const slot: InsertSlot = { id: newId('ins'), pluginId: desc.id, pluginName: desc.name, bypass: false, params: defaultParams(desc) };
            onChange([...inserts, slot]);
            setOpen(slot.id);
          }}
        />
      )}
    </div>
  );
}

export function SourcePicker({ ch }: { ch: Channel }) {
  const s = useConsole();
  const inputs = useEngineInputs();
  const set = (patch: Partial<Channel['source']>) => s.updateChannel(ch.id, { source: { ...ch.source, ...patch } });
  return (
    <div className="row wrap">
      <span className="ms-label">
        <MonoStereoSwitch ch={ch} size={20} /> {ch.stereo ? 'Stereo' : 'Mono'}
      </span>
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
          <select value={ch.source.deviceChannel ?? 0} onChange={(e) => set({ deviceChannel: Number(e.target.value), deviceChannelR: undefined })} title={ch.stereo ? 'Left input' : 'Input'}>
            {Array.from({ length: inputs.channelsFor(ch.source.deviceId) }, (_, i) => (
              <option key={i} value={i}>
                {ch.stereo ? 'L: ' : ''}{inputs.channelName(ch.source.deviceId, i)}
              </option>
            ))}
          </select>
          {ch.stereo && (
            <select value={ch.source.deviceChannelR ?? (ch.source.deviceChannel ?? 0) + 1} onChange={(e) => set({ deviceChannelR: Number(e.target.value) })} title="Right input">
              {Array.from({ length: inputs.channelsFor(ch.source.deviceId) }, (_, i) => (
                <option key={i} value={i}>
                  R: {inputs.channelName(ch.source.deviceId, i)}
                </option>
              ))}
            </select>
          )}
        </>
      )}
    </div>
  );
}

const LINK_OPTION_LABELS: [LinkOption, string][] = [
  ['fader', 'Fader'],
  ['mute', 'Mute'],
  ['solo', 'Solo'],
  ['sends', 'Sends'],
  ['groups', 'Groups'],
  ['input', 'Gain/delay'],
];

export function LinkSection({ ch }: { ch: Channel }) {
  const s = useConsole();
  const info = linkInfo(s, ch.id);
  const partnerId = info?.partner ?? naturalPartner(ch.id);
  const partner = s.channels.find((c) => c.id === partnerId);
  if (!partner) return null;
  return (
    <div className="section">
      <div className="section-title">
        Stereo link {info && <span className="hint">this is the {info.side === 'L' ? 'left' : 'right'} side · paired with {partner.name}</span>}
      </div>
      {!info ? (
        <div className="row">
          <button
            onClick={() => {
              const [left, right] = Number(ch.id.slice(2)) % 2 === 1 ? [ch.id, partnerId] : [partnerId, ch.id];
              s.update((st) => createLink(st, left, right));
            }}
          >
            Link with {partner.name} (ch {partnerId.slice(2)})
          </button>
          <span className="hint">pans go hard L/R</span>
        </div>
      ) : (
        <>
          <div className="link-opts">
            {LINK_OPTION_LABELS.map(([opt, label]) => (
              <Toggle key={opt} small on={info.link.options[opt]} onClick={() => s.update((st) => setLinkOption(st, ch.id, opt, !info.link.options[opt]))} title={`Link ${label} between the two sides`}>
                {label}
              </Toggle>
            ))}
          </div>
          <div className="row">
            <button onClick={() => s.update((st) => removeLink(st, ch.id))}>Unlink</button>
            <span className="hint">Pan and plugins are always per side, so each side can have its own rack processing.</span>
          </div>
        </>
      )}
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
        <div className="section-title">Output</div>
        <div className="row wrap">
          <select value={b.output ?? 'none'} onChange={(e) => up({ output: e.target.value })} title="Where this bus goes after its fader">
            <option value="main">Main LR</option>
            <option value="none">Nowhere (physical outputs only)</option>
            {s.buses
              .filter((x) => x.id !== b.id && x.type !== 'mixminus' && !createsLoop(s, b.id, x.id))
              .map((x) => <option key={x.id} value={x.id}>→ {x.id.slice(3)} · {x.name}</option>)}
          </select>
          <span className="hint">
            Fed by: {[
              ...s.channels.filter((c) => (c.routes ?? []).includes(b.id)).map((c) => c.name),
              ...s.buses.filter((x) => x.output === b.id).map((x) => x.name),
              ...s.channels.filter((c) => c.sends[b.id]?.on).map((c) => `${c.name} (send)`),
            ].join(', ') || 'nothing yet'}
          </span>
        </div>
        <div className="section-title">Bus type</div>
        <div className="row wrap">
          <select value={b.type} onChange={(e) => up({ type: e.target.value as typeof b.type })}>
            <option value="aux">Bus (group, aux, FX, feed: routing decides)</option>
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
        <p className="hint">Master-bus processing (EQ, glue compression, true-peak limiter) goes in the inserts below. Watch <b>TP max</b> under the loudness meter to confirm the chain holds your ceiling.</p>
      </div>
      <Inserts inserts={s.main.inserts} onChange={(inserts) => s.updateMain({ inserts })} />
    </div>
  );
}

export function Detail() {
  const sel = useConsole((s) => s.selected);
  const ch = useConsole((s) => (sel?.kind === 'channel' ? s.channels.find((c) => c.id === sel.id) : undefined));
  if (!sel) return <div className="detail empty">Select a strip</div>;
  if (sel.kind === 'channel' && ch) return <ChannelPanel ch={ch} />;
  if (sel.kind === 'bus') return <BusDetail id={sel.id} />;
  if (sel.kind === 'dca') return <DcaDetail id={sel.id} />;
  if (sel.kind === 'main') return <MainDetail />;
  return null;
}
