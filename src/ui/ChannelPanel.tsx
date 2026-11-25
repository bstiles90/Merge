// Selected-channel panel: one stage at a time following the signal flow (IN · RACK · SENDS · ASSIGN).
// Channels have no built-in processing: filtering, EQ and dynamics come from plugins in the rack.

import { useState } from 'react';
import { useConsole } from '../core/store';
import { linkInfo } from '../core/links';
import type { Channel, Send } from '../core/types';
import { getPlugin } from '../core/plugins';
import { applyTapValue, tapChoices, tapValue } from '../core/sends';
import { fmtDb, fmtMs, Knob, Toggle } from './controls';
import { ColorPicker, Inserts, LinkSection, SourcePicker } from './Detail';

type Tab = 'in' | 'fx' | 'sends' | 'assign';
let lastTab: Tab = 'fx'; // remembered while moving between channels


// ------------------------------------------------------------------ other tabs
function InTab({ ch }: { ch: Channel }) {
  const s = useConsole();
  const up = (p: Partial<Channel>) => s.updateChannel(ch.id, p);
  return (
    <div className="tab-body">
      <div className="section-title">Source</div>
      <SourcePicker ch={ch} />
      <div className="in-row">
        <Knob size={56} label="Gain" value={ch.gainDb} min={-24} max={48} defaultValue={0} format={fmtDb} onChange={(gainDb) => up({ gainDb })} />
        <Knob size={40} label="Delay" value={ch.delayMs} min={0} max={500} defaultValue={0} format={fmtMs} onChange={(delayMs) => up({ delayMs })} />
        <div className="col">
          <Toggle on={ch.phaseInvert} onClick={() => up({ phaseInvert: !ch.phaseInvert })} title="Polarity invert">Ø</Toggle>
        </div>
      </div>
      <div className="row wrap">
        <Toggle on={ch.inputMode === 'playback'} onClick={() => up({ inputMode: ch.inputMode === 'live' ? 'playback' : 'live' })} small title="Virtual soundcheck: feed this channel from its recorded track">
          {ch.inputMode === 'live' ? 'LIVE INPUT' : 'PLAYBACK'}
        </Toggle>
        <Toggle kind="rec" on={ch.recArm} onClick={() => up({ recArm: !ch.recArm })} small>REC ARM</Toggle>
        <Toggle kind="safe" on={ch.recallSafe} onClick={() => up({ recallSafe: !ch.recallSafe })} small title="Scenes won't change this channel">RECALL SAFE</Toggle>
      </div>
      <LinkSection ch={ch} />
    </div>
  );
}

function SendsTab({ ch }: { ch: Channel }) {
  const s = useConsole();
  const up = (p: Partial<Channel>) => s.updateChannel(ch.id, p);
  return (
    <div className="tab-body">
      <div className="row">
        <select value="" onChange={(e) => e.target.value && up({ sends: { ...ch.sends, [e.target.value]: { on: true, levelDb: 0, pre: false, tap: 'post' } } })}>
          <option value="">+ Add send to…</option>
          {s.buses
            .filter((b) => b.type !== 'mixminus' && !(ch.sends[b.id]?.on || isFinite(ch.sends[b.id]?.levelDb ?? -Infinity)) && !(ch.routes ?? []).includes(b.id))
            .map((b) => <option key={b.id} value={b.id}>{b.id.slice(3)} · {b.name}</option>)}
        </select>
        <span className="hint">Sends (aux, FX, feeds) have their own level and tap point: INPUT, PRE (after the rack or after a chosen plugin), POST or PSP. To make a channel part of a group, use ASSIGN.</span>
      </div>
      <div className="sends sends-big">
        {s.buses.filter((b) => b.type === 'mixminus' || ch.sends[b.id]?.on || isFinite(ch.sends[b.id]?.levelDb ?? -Infinity)).map((b) => {
          if (b.type === 'mixminus') {
            const included = ch.mainAssign && b.mixMinusExclude !== ch.id;
            return (
              <div key={b.id} className="send mm">
                <span className="send-name">{b.name}</span>
                <span className="hint">{included ? 'mix-minus: auto (from main)' : 'excluded from this mix-minus'}</span>
              </div>
            );
          }
          const snd: Send = ch.sends[b.id] ?? { on: false, levelDb: -Infinity, pre: false };
          const setSend = (p: Partial<typeof snd>) => up({ sends: { ...ch.sends, [b.id]: { ...snd, ...p } } });
          return (
            <div key={b.id} className={'send' + (snd.on ? ' on' : '')}>
              <Toggle small on={snd.on} onClick={() => setSend({ on: !snd.on, levelDb: isFinite(snd.levelDb) ? snd.levelDb : 0 })}>{b.name}</Toggle>
              <input type="range" min={-60} max={10} step={0.5} value={isFinite(snd.levelDb) ? snd.levelDb : -60} onChange={(e) => setSend({ levelDb: Number(e.target.value) <= -60 ? -Infinity : Number(e.target.value), on: true })} />
              <span className="send-db">{isFinite(snd.levelDb) ? fmtDb(snd.levelDb) : '-∞'}</span>
              <select className="tap-select" value={tapValue(snd)} title="Tap point: where this send picks up the channel" onChange={(e) => up({ sends: { ...ch.sends, [b.id]: applyTapValue(snd, e.target.value) } })}>
                {tapChoices(ch, (id, fb) => getPlugin(id)?.name ?? fb ?? 'Plugin').map((c) => <option key={c.value} value={c.value} title={c.label}>{c.short}</option>)}
              </select>
              <button className="icon-btn" title="Remove this send" onClick={() => { const { [b.id]: _gone, ...rest } = ch.sends; up({ sends: rest }); }}>✕</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AssignTab({ ch }: { ch: Channel }) {
  const s = useConsole();
  const up = (p: Partial<Channel>) => s.updateChannel(ch.id, p);
  return (
    <div className="tab-body">
      <div className="section-title">Output</div>
      <p className="hint">Where this channel goes after its fader and pan. E.g. kick → Drums only (Main LR off), and the Drums bus goes to Main LR.</p>
      <div className="chips">
        <button className={'chip' + (ch.mainAssign ? ' on' : '')} onClick={() => up({ mainAssign: !ch.mainAssign })}>Main LR</button>
        {(ch.routes ?? []).map((id) => {
          const b = s.buses.find((x) => x.id === id);
          return (
            <button key={id} className="chip on" style={{ background: b?.color }} title="Click to remove" onClick={() => up({ routes: (ch.routes ?? []).filter((x) => x !== id) })}>
              {b?.name ?? id} ✕
            </button>
          );
        })}
        <select
          value=""
          onChange={(e) => e.target.value && up({ routes: [...(ch.routes ?? []), e.target.value] })}
          title="Assign this channel's output to a bus (group)"
        >
          <option value="">+ bus…</option>
          {s.buses
            .filter((b) => b.type !== 'mixminus' && !(ch.routes ?? []).includes(b.id))
            .map((b) => <option key={b.id} value={b.id}>{b.id.slice(3)} · {b.name}</option>)}
        </select>
      </div>
      <div className="section-title">DCAs</div>
      <div className="chips">
        {s.dcas.map((d) => (
          <button key={d.id} className={'chip' + (ch.dcas.includes(d.id) ? ' on' : '')} style={ch.dcas.includes(d.id) ? { background: d.color } : undefined} onClick={() => up({ dcas: ch.dcas.includes(d.id) ? ch.dcas.filter((x) => x !== d.id) : [...ch.dcas, d.id] })}>
            {d.name}
          </button>
        ))}
      </div>
      <div className="section-title">Mute groups</div>
      <div className="chips">
        {s.muteGroups.map((g) => (
          <button key={g.id} className={'chip mg' + (ch.muteGroups.includes(g.id) ? ' on' : '')} onClick={() => up({ muteGroups: ch.muteGroups.includes(g.id) ? ch.muteGroups.filter((x) => x !== g.id) : [...ch.muteGroups, g.id] })}>
            {g.name}
          </button>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the panel
export function ChannelPanel({ ch }: { ch: Channel }) {
  const s = useConsole();
  const [tab, setTabState] = useState<Tab>(lastTab);
  const setTab = (t: Tab) => {
    lastTab = t;
    setTabState(t);
  };
  const link = linkInfo(s, ch.id);
  const sendCount = Object.values(ch.sends).filter((x) => x.on).length;
  const tabs: [Tab, string, boolean | string][] = [
    ['in', 'IN', ch.gainDb !== 0 || ch.phaseInvert || ch.delayMs > 0],
    ['fx', 'RACK', ch.inserts.length ? String(ch.inserts.length) : false],
    ['sends', 'SENDS', sendCount ? String(sendCount) : false],
    ['assign', 'ASSIGN', false],
  ];
  return (
    <div className="detail chpanel">
      <div className="chp-head" style={{ borderColor: ch.color }}>
        <span className="chp-num" style={{ background: ch.color }}>{ch.id.replace('ch', '')}</span>
        <input className="name-input" value={ch.name} onChange={(e) => s.updateChannel(ch.id, { name: e.target.value })} />
        {link && <span className="hint">stereo {link.side} ↔ {s.channels.find((c) => c.id === link.partner)?.name}</span>}
      </div>
      <ColorPicker value={ch.color} onChange={(color) => s.updateChannel(ch.id, { color })} />
      <div className="chp-tabs">
        {tabs.map(([id, label, badge]) => (
          <button key={id} className={'chp-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>
            {label}
            {badge && <span className={'chp-badge' + (typeof badge === 'string' ? ' count' : '')}>{typeof badge === 'string' ? badge : ''}</span>}
          </button>
        ))}
      </div>
      <div className="chp-content">
        {tab === 'in' && <InTab ch={ch} />}
        {tab === 'fx' && (
          <div className="tab-body">
            <Inserts inserts={ch.inserts} onChange={(inserts) => s.updateChannel(ch.id, { inserts })} />
          </div>
        )}
        {tab === 'sends' && <SendsTab ch={ch} />}
        {tab === 'assign' && <AssignTab ch={ch} />}
      </div>
    </div>
  );
}
