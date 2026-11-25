// Channel inspector without scrolling: everything for the channel is in view at once.
//   left : meter + fader, full height        right: input / gain / Ø / delay, pan + mute / PFL,
//          8 plugin slots, sends, output + DCAs + mute groups, link / playback / rec / safe.

import { useState } from 'react';
import { channelMuteReason } from '../core/mix';
import { PALETTE } from '../core/defaults';
import { getPlugin, type PluginDescriptor } from '../core/plugins';
import { createLink, linkInfo, naturalPartner, removeLink } from '../core/links';
import { routableBuses } from '../core/buses';
import { useConsole } from '../core/store';
import type { Channel, InsertSlot } from '../core/types';
import { sendNative, useNative } from '../native/bridge';
import { Knob, Toggle } from './controls';
import { ChannelOutput, MonoStereoSwitch, SendRow, newInsert } from './Strip';
import { TallMeter } from './StripOverview';
import { PluginPicker } from './PluginPicker';
import { useEngineInputs } from './useEngine';
import { closeDrawer } from './uiState';

const panText = (p: number) => (Math.abs(p) < 0.01 ? 'C' : p < 0 ? `L${Math.round(-p * 100)}` : `R${Math.round(p * 100)}`);
const gainColor = (db: number) => (db > 0.05 ? '#f2a33c' : db < -0.05 ? '#3cc6d9' : '#8b929b');

function ColorDot({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="color-dot-wrap">
      <button className="color-dot big" style={{ background: value }} title="Colour" onClick={() => setOpen(!open)} />
      {open && (
        <span className="color-pop" onMouseLeave={() => setOpen(false)}>
          {PALETTE.map((c) => (
            <button key={c} className={'swatch' + (c === value ? ' on' : '')} style={{ background: c }} onClick={() => { onChange(c); setOpen(false); }} />
          ))}
        </span>
      )}
    </span>
  );
}

function SourceSelect({ ch }: { ch: Channel }) {
  const s = useConsole();
  const { devices, channelsFor, channelName } = useEngineInputs();
  const value = ch.source.kind === 'input' ? `in:${ch.source.deviceId ?? ''}:${ch.source.deviceChannel ?? 0}` : ch.source.kind;
  return (
    <select className="ins-source" value={value} title="Input"
      onChange={(e) => {
        const v = e.target.value;
        if (v.startsWith('in:')) {
          const [, deviceId, n] = v.split(':');
          s.updateChannel(ch.id, { source: { ...ch.source, kind: 'input', deviceId, deviceChannel: Number(n), deviceChannelR: undefined } });
        } else s.updateChannel(ch.id, { source: { ...ch.source, kind: v as Channel['source']['kind'] } });
      }}>
      <option value="none">No input</option>
      {devices.map((d) => (
        <optgroup key={d.deviceId} label={d.label || d.deviceId.slice(0, 8)}>
          {Array.from({ length: channelsFor(d.deviceId) }, (_, i) =>
            ch.stereo && i + 1 >= channelsFor(d.deviceId) ? null : (
              <option key={i} value={`in:${d.deviceId}:${i}`}>{ch.stereo ? `${i + 1}/${i + 2} ${channelName(d.deviceId, i)}` : `${i + 1} ${channelName(d.deviceId, i)}`}</option>
            ),
          )}
        </optgroup>
      ))}
      {ch.source.kind === 'input' && !devices.some((d) => d.deviceId === ch.source.deviceId) && <option value={value}>IN {(ch.source.deviceChannel ?? 0) + 1}</option>}
      <optgroup label="Test">
        <option value="tone">Tone</option>
        <option value="noise">Pink noise</option>
        <option value="speech">Speech</option>
      </optgroup>
    </select>
  );
}

/** 8 plugin slots: dot = bypass, name = open / close its window, lock = recall safe, ✕ remove. */
function Rack({ ch }: { ch: Channel }) {
  const s = useConsole();
  const nativeOn = useNative((st) => st.status === 'connected');
  const native = useNative((st) => st.inserts);
  const [picker, setPicker] = useState<DOMRect | null>(null);
  const set = (inserts: InsertSlot[]) => s.updateChannel(ch.id, { inserts });
  return (
    <div className="ins-rack">
      {Array.from({ length: 8 }, (_, i) => {
        const ins = ch.inserts[i];
        if (!ins)
          return i === ch.inserts.length ? (
            <button key={i} className="ins-slot add" onClick={(e) => setPicker((e.currentTarget as HTMLElement).getBoundingClientRect())}>+ plugin</button>
          ) : (
            <div key={i} className="ins-slot empty" />
          );
        const n = native[ins.id];
        const name = getPlugin(ins.pluginId)?.name ?? ins.pluginName ?? 'Plugin';
        const canWin = nativeOn && !ins.pluginId.startsWith('builtin.') && !n?.error;
        return (
          <div key={ins.id} className={'ins-slot used' + (ins.bypass ? ' byp' : '') + (n?.editorOpen ? ' open' : '') + (n?.error ? ' err' : '')}>
            <button className="ins-dot" title={ins.bypass ? 'Bypassed' : 'On'} onClick={() => set(ch.inserts.map((x) => (x.id === ins.id ? { ...x, bypass: !x.bypass } : x)))} />
            <button className="ins-name" title={n?.error ?? (canWin ? 'Open / close window' : name)} onClick={() => canWin && sendNative({ type: 'insert.editor', slotId: ins.id, open: !n?.editorOpen })}>
              {name}
            </button>
            <button className={'ins-lock' + (ins.recallSafe ? ' on' : '')} title="Recall safe" onClick={() => set(ch.inserts.map((x) => (x.id === ins.id ? { ...x, recallSafe: !x.recallSafe } : x)))}>
              {ins.recallSafe ? '🔒' : '🔓'}
            </button>
            <button className="ins-x" title="Remove" onClick={() => set(ch.inserts.filter((x) => x.id !== ins.id))}>✕</button>
          </div>
        );
      })}
      {picker && (
        <PluginPicker anchor={picker} onClose={() => setPicker(null)} onPick={(p: PluginDescriptor) => { setPicker(null); set([...ch.inserts, newInsert(p)]); }} />
      )}
    </div>
  );
}

const MAX_SENDS = 6;
function Sends({ ch }: { ch: Channel }) {
  const s = useConsole();
  const used = routableBuses(s).filter((b) => ch.sends[b.id] && (ch.sends[b.id].on || isFinite(ch.sends[b.id].levelDb)));
  const free = routableBuses(s).filter((b) => !used.includes(b));
  return (
    <div className="ins-sends">
      {used.slice(0, MAX_SENDS).map((b) => <SendRow key={b.id} ch={ch} b={b} />)}
      {used.length > MAX_SENDS && <span className="hint">+{used.length - MAX_SENDS} more on the strip</span>}
      {used.length < MAX_SENDS && free.length > 0 && (
        <select className="ins-add-send" value="" onChange={(e) => e.target.value && s.updateChannel(ch.id, { sends: { ...ch.sends, [e.target.value]: { on: true, levelDb: 0, pre: false, tap: 'post' } } })}>
          <option value="">+ send</option>
          {free.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      )}
    </div>
  );
}

function Groups({ ch }: { ch: Channel }) {
  const s = useConsole();
  const toggle = (key: 'dcas' | 'muteGroups', id: string) =>
    s.updateChannel(ch.id, (c) => ({ [key]: c[key].includes(id) ? c[key].filter((x) => x !== id) : [...c[key], id] }) as Partial<Channel>);
  return (
    <div className="ins-groups">
      <span className="ins-label">DCA</span>
      <div className="ins-chips">
        {s.dcas.map((d, i) => (
          <button key={d.id} className={'ins-chip' + (ch.dcas.includes(d.id) ? ' on dca' : '')} title={d.name} onClick={() => toggle('dcas', d.id)}>{i + 1}</button>
        ))}
      </div>
      <span className="ins-label">MUTE</span>
      <div className="ins-chips">
        {s.muteGroups.map((g, i) => (
          <button key={g.id} className={'ins-chip' + (ch.muteGroups.includes(g.id) ? ' on mg' : '')} title={g.name} onClick={() => toggle('muteGroups', g.id)}>{i + 1}</button>
        ))}
      </div>
    </div>
  );
}

export function Inspector({ ch, closable = true }: { ch: Channel; closable?: boolean }) {
  const s = useConsole();
  const up = (p: Partial<Channel>) => s.updateChannel(ch.id, p);
  const mr = channelMuteReason(s, ch);
  const link = linkInfo(s, ch.id);
  const partner = link ? s.channels.find((c) => c.id === link.partner) : s.channels.find((c) => c.id === naturalPartner(ch.id));
  return (
    <div className="inspector">
      <div className="ins-head">
        <span className="ins-num" style={{ background: ch.color }}>{ch.id.slice(2).padStart(2, '0')}</span>
        <ColorDot value={ch.color} onChange={(color) => up({ color })} />
        <input className="ins-name-input" value={ch.name} onChange={(e) => up({ name: e.target.value })} />
        {closable && <button className="icon-btn" title="Close (Esc)" onClick={closeDrawer}>✕</button>}
      </div>
      <div className="ins-body">
        <TallMeter id={ch.id} stereo={!!ch.stereo} refr={{ kind: 'channel', id: ch.id }} faderDb={ch.faderDb} color={ch.color} />
        <div className="ins-main">
          <div className="ins-block ins-input">
            <div className="ins-row">
              <MonoStereoSwitch ch={ch} size={18} />
              <SourceSelect ch={ch} />
            </div>
            <div className="ins-row ins-knobs">
              <Knob size={42} label="Gain" value={ch.gainDb} min={-24} max={48} defaultValue={0} color={gainColor(ch.gainDb)} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`} onChange={(gainDb) => up({ gainDb: Math.abs(gainDb) < 0.3 ? 0 : gainDb })} />
              <Knob size={42} label={ch.stereo ? 'Balance' : 'Pan'} value={ch.pan} min={-1} max={1} defaultValue={0} format={panText} onChange={(pan) => up({ pan: Math.abs(pan) < 0.02 ? 0 : pan })} />
              <div className="ins-col">
                <Toggle small on={ch.phaseInvert} onClick={() => up({ phaseInvert: !ch.phaseInvert })} title="Polarity">Ø</Toggle>
                <label className="ins-delay" title="Delay (ms)">
                  <input type="number" min={0} max={500} step={1} value={Math.round(ch.delayMs)} onChange={(e) => up({ delayMs: Math.max(0, Math.min(500, Number(e.target.value) || 0)) })} />
                  <span>ms</span>
                </label>
              </div>
            </div>
            <div className="ins-row ins-mute">
              <button className={'mute-btn' + (ch.mute ? ' on' : '') + (mr.muted && !mr.self ? ' group' : '')} onClick={() => s.dispatch({ type: 'channel.mute.toggle', args: { id: ch.id } })}>MUTE</button>
              <button className={'tgl tgl-solo' + (ch.solo ? ' on' : '')} onClick={() => s.dispatch({ type: 'channel.solo.toggle', args: { id: ch.id } })}>{s.monitor.soloMode === 'pfl' ? 'PFL' : 'AFL'}</button>
            </div>
          </div>
          <div className="ins-block">
            <span className="ins-label">PLUGINS</span>
            <Rack ch={ch} />
          </div>
          <div className="ins-block">
            <span className="ins-label">SENDS</span>
            <Sends ch={ch} />
          </div>
          <div className="ins-block">
            <div className="ins-row"><span className="ins-label">OUT</span><ChannelOutput ch={ch} /></div>
            <Groups ch={ch} />
          </div>
          <div className="ins-row ins-flags">
            <Toggle small on={!!link} title={link ? `Unlink from ${partner?.name}` : `Stereo-link with ${partner?.name}`}
              onClick={() => s.update((st) => (link ? removeLink(st, ch.id) : createLink(st, Math.min(+ch.id.slice(2), +naturalPartner(ch.id).slice(2)) === +ch.id.slice(2) ? ch.id : naturalPartner(ch.id), Math.min(+ch.id.slice(2), +naturalPartner(ch.id).slice(2)) === +ch.id.slice(2) ? naturalPartner(ch.id) : ch.id)))}>
              {link ? `LINK ${link.side}` : 'LINK'}
            </Toggle>
            <Toggle small on={ch.inputMode === 'playback'} onClick={() => up({ inputMode: ch.inputMode === 'live' ? 'playback' : 'live' })}>{ch.inputMode === 'live' ? 'LIVE' : 'PB'}</Toggle>
            <Toggle kind="rec" small on={ch.recArm} onClick={() => up({ recArm: !ch.recArm })}>REC</Toggle>
            <Toggle kind="safe" small on={ch.recallSafe} onClick={() => up({ recallSafe: !ch.recallSafe })} title="Recall safe">SAFE</Toggle>
          </div>
        </div>
      </div>
    </div>
  );
}
