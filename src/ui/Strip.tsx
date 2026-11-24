import { busMuteReason, channelMuteReason, formatDb } from '../core/mix';
import { useConsole } from '../core/store';
import type { StripRef } from '../core/types';
import { Fader, Meter, Toggle } from './controls';
import { setStripFader } from '../control/midi';
import { useFaderHeight } from './Pages';


export function sameRef(a: StripRef | null, b: StripRef | null) {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  return a.kind === 'main' || (a as { id: string }).id === (b as { id: string }).id;
}

export function Strip({ refr, index }: { refr: StripRef | null; index: number }) {
  const s = useConsole();
  const FADER_H = useFaderHeight();
  if (!refr) return <div className="strip empty"><div className="strip-num">{index + 1}</div></div>;

  const selected = sameRef(s.selected, refr);
  const select = () => s.select(refr);

  if (refr.kind === 'channel') {
    const ch = s.channels.find((c) => c.id === refr.id);
    if (!ch) return null;
    const mr = channelMuteReason(s, ch);
    const groupMuted = mr.muted && !mr.self;
    return (
      <div className={'strip' + (selected ? ' selected' : '')}>
        <div className="strip-head" draggable title="Drag to move this strip" style={{ background: ch.color }} onClick={select}>
          <span className="strip-num">{ch.id.replace('ch', '')}</span>
          <span className="strip-name">{ch.name}</span>
        </div>
        <div className="strip-tags">
          {ch.inputMode === 'playback' && <span className="tag pb" title="Playing back recorded track">PB</span>}
          {ch.recArm && <span className="tag rec">REC</span>}
          {ch.inserts.length > 0 && <span className="tag fx">FX{ch.inserts.length}</span>}
          {ch.recallSafe && <span className="tag safe">SAFE</span>}
        </div>
        <div className="strip-groups">
          {s.muteGroups.map((g) => (
            <span
              key={g.id}
              className={'mg-dot' + (ch.muteGroups.includes(g.id) ? ' member' : '') + (g.active && ch.muteGroups.includes(g.id) ? ' active' : '')}
              title={g.name}
            >
              {g.id.replace('mg', '')}
            </span>
          ))}
        </div>
        <div className="strip-pan" title={`Pan ${ch.pan.toFixed(2)}`} onDoubleClick={() => s.updateChannel(ch.id, { pan: 0 })}>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.01}
            value={ch.pan}
            onChange={(e) => s.updateChannel(ch.id, { pan: Number(e.target.value) })}
          />
        </div>
        <div className="strip-btns">
          <Toggle kind="sel" on={selected} onClick={select} small>SEL</Toggle>
          <Toggle kind="solo" on={ch.solo} onClick={() => s.dispatch({ type: 'channel.solo.toggle', args: { id: ch.id } })} small>
            {s.monitor.soloMode === 'pfl' ? 'PFL' : 'AFL'}
          </Toggle>
        </div>
        <div className="strip-body">
          <Meter id={ch.id} height={FADER_H} showGr />
          <Fader db={ch.faderDb} onChange={(db) => setStripFader(refr, db)} color={ch.color} height={FADER_H} />
        </div>
        <div className="strip-db">{formatDb(ch.faderDb)}</div>
        <button
          className={'mute-btn' + (ch.mute ? ' on' : '') + (groupMuted ? ' group' : '')}
          onClick={() => s.dispatch({ type: 'channel.mute.toggle', args: { id: ch.id } })}
          title={groupMuted ? `Muted by ${[...mr.groups, ...mr.dcas].join(', ')}` : 'Mute'}
        >
          MUTE
        </button>
      </div>
    );
  }

  if (refr.kind === 'bus') {
    const b = s.buses.find((x) => x.id === refr.id);
    if (!b) return null;
    const mr = busMuteReason(s, b);
    return (
      <div className={'strip bus' + (selected ? ' selected' : '')}>
        <div className="strip-head" draggable title="Drag to move this strip" style={{ background: b.color }} onClick={select}>
          <span className="strip-num">{b.type === 'mixminus' ? 'N-1' : 'MIX'}</span>
          <span className="strip-name">{b.name}</span>
        </div>
        <div className="strip-tags">
          {b.inserts.length > 0 && <span className="tag fx">FX{b.inserts.length}</span>}
          {b.type === 'mixminus' && <span className="tag mm">MIX-MINUS</span>}
        </div>
        <div className="strip-groups" />
        <div className="strip-pan" />
        <div className="strip-btns">
          <Toggle kind="sel" on={selected} onClick={select} small>SEL</Toggle>
          <Toggle kind="solo" on={b.solo} onClick={() => s.updateBus(b.id, { solo: !b.solo })} small>
            {s.monitor.soloMode === 'pfl' ? 'PFL' : 'AFL'}
          </Toggle>
        </div>
        <div className="strip-body">
          <Meter id={b.id} height={FADER_H} stereo />
          <Fader db={b.faderDb} onChange={(db) => setStripFader(refr, db)} color={b.color} height={FADER_H} />
        </div>
        <div className="strip-db">{formatDb(b.faderDb)}</div>
        <button
          className={'mute-btn' + (b.mute ? ' on' : '') + (mr.muted && !mr.self ? ' group' : '')}
          onClick={() => s.dispatch({ type: 'bus.mute.toggle', args: { id: b.id } })}
        >
          MUTE
        </button>
      </div>
    );
  }

  if (refr.kind === 'dca') {
    const d = s.dcas.find((x) => x.id === refr.id);
    if (!d) return null;
    const members = s.channels.filter((c) => c.dcas.includes(d.id));
    return (
      <div className={'strip dca' + (selected ? ' selected' : '')}>
        <div className="strip-head" draggable title="Drag to move this strip" style={{ background: d.color }} onClick={select}>
          <span className="strip-num">DCA</span>
          <span className="strip-name">{d.name}</span>
        </div>
        <div className="strip-tags">
          <span className="tag" title={members.map((m) => m.name).join(', ')}>{members.length} ch</span>
        </div>
        <div className="strip-groups" />
        <div className="strip-pan" />
        <div className="strip-btns">
          <Toggle kind="sel" on={selected} onClick={select} small>SEL</Toggle>
        </div>
        <div className="strip-body">
          <div className="meter-spacer" />
          <Fader db={d.faderDb} onChange={(db) => setStripFader(refr, db)} color={d.color} height={FADER_H} />
        </div>
        <div className="strip-db">{formatDb(d.faderDb)}</div>
        <button className={'mute-btn' + (d.mute ? ' on' : '')} onClick={() => s.dispatch({ type: 'dca.mute.toggle', args: { id: d.id } })}>
          MUTE
        </button>
      </div>
    );
  }

  // main
  return (
    <div className={'strip main' + (selected ? ' selected' : '')}>
      <div className="strip-head" draggable title="Drag to move this strip" style={{ background: '#c9ccd1', color: '#111' }} onClick={select}>
        <span className="strip-num">PGM</span>
        <span className="strip-name">Main LR</span>
      </div>
      <div className="strip-tags">{s.main.inserts.length > 0 && <span className="tag fx">FX{s.main.inserts.length}</span>}</div>
      <div className="strip-groups" />
      <div className="strip-pan" />
      <div className="strip-btns">
        <Toggle kind="sel" on={selected} onClick={select} small>SEL</Toggle>
      </div>
      <div className="strip-body">
        <Meter id="main" height={FADER_H} stereo />
        <Fader db={s.main.faderDb} onChange={(db) => setStripFader(refr, db)} color="#fff" height={FADER_H} />
      </div>
      <div className="strip-db">{formatDb(s.main.faderDb)}</div>
      <button className={'mute-btn' + (s.main.mute ? ' on' : '')} onClick={() => s.dispatch({ type: 'main.mute.toggle', args: {} })}>
        MUTE
      </button>
    </div>
  );
}
