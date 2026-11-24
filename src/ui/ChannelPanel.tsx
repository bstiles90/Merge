// Selected-channel panel: one stage at a time following the signal flow (IN · RACK · SENDS · ASSIGN).
// Channels have no built-in processing: filtering, EQ and dynamics come from plugins in the rack.

import { useState } from 'react';
import { useConsole } from '../core/store';
import { linkInfo } from '../core/links';
import type { Channel } from '../core/types';
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
      <div className="sends sends-big">
        {s.buses.map((b) => {
          if (b.type === 'mixminus') {
            const included = ch.mainAssign && b.mixMinusExclude !== ch.id;
            return (
              <div key={b.id} className="send mm">
                <span className="send-name">{b.name}</span>
                <span className="hint">{included ? 'mix-minus: auto (from main)' : 'excluded from this mix-minus'}</span>
              </div>
            );
          }
          const snd = ch.sends[b.id] ?? { on: false, levelDb: -Infinity, pre: false };
          const setSend = (p: Partial<typeof snd>) => up({ sends: { ...ch.sends, [b.id]: { ...snd, ...p } } });
          return (
            <div key={b.id} className={'send' + (snd.on ? ' on' : '')}>
              <Toggle small on={snd.on} onClick={() => setSend({ on: !snd.on, levelDb: isFinite(snd.levelDb) ? snd.levelDb : 0 })}>{b.name}</Toggle>
              <input type="range" min={-60} max={10} step={0.5} value={isFinite(snd.levelDb) ? snd.levelDb : -60} onChange={(e) => setSend({ levelDb: Number(e.target.value) <= -60 ? -Infinity : Number(e.target.value), on: true })} />
              <span className="send-db">{isFinite(snd.levelDb) ? fmtDb(snd.levelDb) : '-∞'}</span>
              <Toggle small on={snd.pre} onClick={() => setSend({ pre: !snd.pre })} title="Pre-fader (e.g. IEM / foldback)">PRE</Toggle>
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
      <div className="row">
        <Toggle on={ch.mainAssign} onClick={() => up({ mainAssign: !ch.mainAssign })}>MAIN LR</Toggle>
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
