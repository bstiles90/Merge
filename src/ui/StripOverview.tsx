// Top of the channel / bus inspector: a big meter (dBFS scale + peak number), the fader, gain and
// pan, mute / PFL, and where the strip comes from and goes to.

import { useEffect, useRef, useState } from 'react';
import { channelMuteReason, busMuteReason, formatDb } from '../core/mix';
import { useConsole } from '../core/store';
import type { StripRef } from '../core/types';
import { setStripFader } from '../control/midi';
import { Fader, Knob, Meter, MeterScale, PeakReadout } from './controls';

const H = 170;
const panText = (p: number) => (Math.abs(p) < 0.01 ? 'C' : p < 0 ? `L${Math.round(-p * 100)}` : `R${Math.round(p * 100)}`);
const gainColor = (db: number) => (db > 0.05 ? '#f2a33c' : db < -0.05 ? '#3cc6d9' : '#8b929b');

/** Fit the meter + fader to the space the panel gives them. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(300);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function StripOverview({ refr }: { refr: StripRef }) {
  const s = useConsole();
  const [ref] = useWidth();
  if (refr.kind === 'channel') {
    const ch = s.channels.find((c) => c.id === refr.id);
    if (!ch) return null;
    const mr = channelMuteReason(s, ch);
    const src = ch.source.kind === 'input' ? `IN ${(ch.source.deviceChannel ?? 0) + 1}${ch.stereo ? `/${(ch.source.deviceChannelR ?? (ch.source.deviceChannel ?? 0) + 1) + 1}` : ''}` : ch.source.kind === 'none' ? 'No input' : ch.source.kind.toUpperCase();
    const dests = [...(ch.mainAssign ? ['Main LR'] : []), ...(ch.routes ?? []).map((id) => s.buses.find((b) => b.id === id)?.name ?? id)];
    return (
      <div className="overview" ref={ref}>
        <div className="ov-meter">
          <MeterScale height={H} />
          <Meter id={ch.id} height={H} stereo={!!ch.stereo} />
          <Fader db={ch.faderDb} onChange={(db) => setStripFader(refr, db)} color={ch.color} height={H} />
        </div>
        <div className="ov-controls">
          <div className="ov-readouts">
            <div><span className="ov-label">INPUT PEAK</span><PeakReadout id={ch.id} /></div>
            <div><span className="ov-label">FADER</span><span className="ov-val num">{formatDb(ch.faderDb)}</span></div>
          </div>
          <div className="ov-knobs">
            <Knob size={44} label="Gain" value={ch.gainDb} min={-24} max={48} defaultValue={0} color={gainColor(ch.gainDb)} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`} onChange={(gainDb) => s.updateChannel(ch.id, { gainDb: Math.abs(gainDb) < 0.3 ? 0 : gainDb })} />
            <Knob size={44} label={ch.stereo ? 'Balance' : 'Pan'} value={ch.pan} min={-1} max={1} defaultValue={0} format={panText} onChange={(pan) => s.updateChannel(ch.id, { pan: Math.abs(pan) < 0.02 ? 0 : pan })} />
          </div>
          <div className="ov-buttons">
            <button className={'mute-btn' + (ch.mute ? ' on' : '') + (mr.muted && !mr.self ? ' group' : '')} onClick={() => s.dispatch({ type: 'channel.mute.toggle', args: { id: ch.id } })}>MUTE</button>
            <button className={'tgl tgl-solo' + (ch.solo ? ' on' : '')} onClick={() => s.dispatch({ type: 'channel.solo.toggle', args: { id: ch.id } })}>{s.monitor.soloMode === 'pfl' ? 'PFL' : 'AFL'}</button>
          </div>
          <div className="ov-flow">
            <span className="ov-label">IN</span> <b>{src}</b>
            <span className="ov-label">OUT</span> <b className={dests.length ? '' : 'bad-text'}>{dests.join(', ') || 'No output'}</b>
          </div>
        </div>
      </div>
    );
  }
  if (refr.kind === 'bus') {
    const b = s.buses.find((x) => x.id === refr.id);
    if (!b) return null;
    const mr = busMuteReason(s, b);
    const out = b.output === 'main' ? 'Main LR' : !b.output || b.output === 'none' ? 'Outputs only' : s.buses.find((x) => x.id === b.output)?.name ?? b.output;
    return (
      <div className="overview" ref={ref}>
        <div className="ov-meter">
          <MeterScale height={H} />
          <Meter id={b.id} height={H} stereo />
          <Fader db={b.faderDb} onChange={(db) => setStripFader(refr, db)} color={b.color} height={H} />
        </div>
        <div className="ov-controls">
          <div className="ov-readouts">
            <div><span className="ov-label">PEAK</span><PeakReadout id={b.id} /></div>
            <div><span className="ov-label">FADER</span><span className="ov-val num">{formatDb(b.faderDb)}</span></div>
          </div>
          <div className="ov-buttons">
            <button className={'mute-btn' + (b.mute ? ' on' : '') + (mr.muted && !mr.self ? ' group' : '')} onClick={() => s.dispatch({ type: 'bus.mute.toggle', args: { id: b.id } })}>MUTE</button>
            <button className={'tgl tgl-solo' + (b.solo ? ' on' : '')} onClick={() => s.updateBus(b.id, { solo: !b.solo })}>{s.monitor.soloMode === 'pfl' ? 'PFL' : 'AFL'}</button>
          </div>
          <div className="ov-flow">
            <span className="ov-label">OUT</span> <b>{out}</b>
          </div>
        </div>
      </div>
    );
  }
  return null;
}
