import { useEffect, useRef, useState } from 'react';
import { busMuteReason, channelMuteReason, formatDb } from '../core/mix';
import { getPlugin } from '../core/plugins';
import { linkInfo } from '../core/links';
import { useConsole } from '../core/store';
import type { Bus, Channel, InsertSlot, StripRef } from '../core/types';
import { Fader, Knob, Meter, Toggle } from './controls';
import { setStripFader } from '../control/midi';
import { openInDock } from './uiState';

export function sameRef(a: StripRef | null, b: StripRef | null) {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  return a.kind === 'main' || (a as { id: string }).id === (b as { id: string }).id;
}

/** Height of the fader area, measured so faders use whatever space the window gives the strip. */
function useHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [h, setH] = useState(220);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setH(Math.max(100, Math.round(e.contentRect.height))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, h] as const;
}

const isControl = (t: EventTarget | null) =>
  !!(t as HTMLElement | null)?.closest?.('button, input, select, .fader, .knob, .minibar, .rack-slot');

// ------------------------------------------------------------------ strip sections
function sourceLabel(ch: Channel) {
  if (ch.inputMode === 'playback') return 'PB';
  switch (ch.source.kind) {
    case 'input':
      return `IN ${(ch.source.deviceChannel ?? 0) + 1}`;
    case 'tone':
      return 'TONE';
    case 'noise':
      return 'NOISE';
    case 'speech':
      return 'SPCH';
    default:
      return '—';
  }
}

function InputSection({ ch }: { ch: Channel }) {
  const s = useConsole();
  return (
    <div className="sec sec-input">
      <div className="sec-src" title="Input source (patch in the channel settings or I/O)">
        {sourceLabel(ch)}
        {ch.phaseInvert && <span className="phase">Ø</span>}
      </div>
      <Knob size={24} value={ch.gainDb} min={-24} max={48} defaultValue={0} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}`} onChange={(gainDb) => s.updateChannel(ch.id, { gainDb })} />
    </div>
  );
}

function RackSection({ inserts, onSelect }: { inserts?: InsertSlot[]; onSelect?: () => void }) {
  const open = (ins?: InsertSlot) => {
    onSelect?.();
    if (ins) openInDock(ins.id);
  };
  const slots = Array.from({ length: 8 }, (_, i) => inserts?.[i]);
  return (
    <div className="sec sec-rack">
      {inserts &&
        slots.map((ins, i) => {
          const name = ins ? getPlugin(ins.pluginId)?.name ?? ins.pluginName ?? 'Plugin' : '';
          return (
            <div
              key={i}
              className={'rack-slot' + (ins ? ' used' : '') + (ins?.bypass ? ' byp' : '')}
              title={ins ? `${name}${ins.bypass ? ' (bypassed)' : ''} — click to open below` : 'Empty insert — add in the RACK tab'}
              onClick={() => open(ins)}
            >
              {ins ? name : '·'}
            </div>
          );
        })}
    </div>
  );
}

/** Horizontal send/level bar: drag sideways to change (relative), double-click to switch on/off. */
function MiniBar({ label, db, on, onChange, onToggle, auto }: { label: string; db: number; on: boolean; onChange: (db: number) => void; onToggle: () => void; auto?: boolean }) {
  const drag = useRef<{ x: number; db: number } | null>(null);
  const frac = isFinite(db) ? Math.max(0, Math.min(1, (db + 60) / 70)) : 0;
  return (
    <div
      className={'minibar' + (on ? ' on' : '') + (auto ? ' auto' : '')}
      title={auto ? `${label}: mix-minus (automatic)` : `${label}: ${isFinite(db) ? db.toFixed(1) : '-∞'} dB${on ? '' : ' (off)'} — drag sideways, double-click on/off`}
      onPointerDown={(e) => {
        if (auto) return;
        e.stopPropagation();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, db: isFinite(db) ? db : -60 };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const next = Math.max(-60, Math.min(10, drag.current.db + (e.clientX - drag.current.x) * (e.shiftKey ? 0.1 : 0.5)));
        onChange(next <= -60 ? -Infinity : Math.round(next * 2) / 2);
      }}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={() => !auto && onToggle()}
    >
      <span className="mb-label">{label}</span>
      <span className="mb-track">
        <span className="mb-fill" style={{ width: `${auto ? 100 : frac * 100}%` }} />
      </span>
    </div>
  );
}

function SendsSection({ ch }: { ch?: Channel }) {
  const s = useConsole();
  return (
    <div className="sec sec-sends">
      {ch &&
        s.buses.map((b: Bus, i) => {
          if (b.type === 'mixminus')
            return <MiniBar key={b.id} label={`${i + 1}`} db={0} on={ch.mainAssign && b.mixMinusExclude !== ch.id} auto onChange={() => {}} onToggle={() => {}} />;
          const snd = ch.sends[b.id] ?? { on: false, levelDb: -Infinity, pre: false };
          return (
            <MiniBar
              key={b.id}
              label={`${i + 1}`}
              db={snd.levelDb}
              on={snd.on}
              onChange={(levelDb) => s.updateChannel(ch.id, { sends: { ...ch.sends, [b.id]: { ...snd, levelDb, on: true } } })}
              onToggle={() => s.updateChannel(ch.id, { sends: { ...ch.sends, [b.id]: { ...snd, on: !snd.on, levelDb: isFinite(snd.levelDb) ? snd.levelDb : 0 } } })}
            />
          );
        })}
    </div>
  );
}

const panText = (p: number) => (Math.abs(p) < 0.01 ? 'C' : p < 0 ? `L${Math.round(-p * 100)}` : `R${Math.round(p * 100)}`);

// ------------------------------------------------------------------ the strip
export function Strip({ refr, index }: { refr: StripRef | null; index: number }) {
  const s = useConsole();
  const [bodyRef, faderH] = useHeight<HTMLDivElement>();
  if (!refr) return <div className="strip empty"><div className="strip-num">{index + 1}</div></div>;

  const selected = sameRef(s.selected, refr);
  const select = () => s.select(refr);
  const onStripClick = (e: React.MouseEvent) => {
    if (!isControl(e.target)) select();
  };

  let head: React.ReactNode, sections: React.ReactNode, buttons: React.ReactNode, meter: React.ReactNode, fader: React.ReactNode, dbText: string, mute: React.ReactNode;
  let cls = 'strip';

  if (refr.kind === 'channel') {
    const ch = s.channels.find((c) => c.id === refr.id);
    if (!ch) return null;
    const mr = channelMuteReason(s, ch);
    const link = linkInfo(s, ch.id);
    head = (
      <div className="strip-head" draggable title="Drag to move this strip" style={{ background: ch.color }}>
        <span className="strip-num">
          {ch.id.replace('ch', '')}
          {link && <span className="link-badge" title={`Stereo linked with ${s.channels.find((c) => c.id === link.partner)?.name}`}>{link.side === 'L' ? '⟦L' : 'R⟧'}</span>}
          {ch.inputMode === 'playback' && <span className="mini-tag pb">PB</span>}
          {ch.recArm && <span className="mini-tag rec">REC</span>}
          {ch.recallSafe && <span className="mini-tag safe">S</span>}
        </span>
        <span className="strip-name">{ch.name}</span>
      </div>
    );
    sections = (
      <>
        <InputSection ch={ch} />
        <RackSection inserts={ch.inserts} onSelect={select} />
        <SendsSection ch={ch} />
        <div className="sec sec-pan">
          <Knob size={30} value={ch.pan} min={-1} max={1} defaultValue={0} format={panText} onChange={(pan) => s.updateChannel(ch.id, { pan: Math.abs(pan) < 0.02 ? 0 : pan })} />
        </div>
        <div className="sec sec-groups">
          {s.muteGroups.map((g) => (
            <span key={g.id} className={'mg-dot' + (ch.muteGroups.includes(g.id) ? ' member' : '') + (g.active && ch.muteGroups.includes(g.id) ? ' active' : '')} title={g.name}>
              {g.id.replace('mg', '')}
            </span>
          ))}
        </div>
      </>
    );
    buttons = (
      <>
        <Toggle kind="sel" on={selected} onClick={select} small>SEL</Toggle>
        <Toggle kind="solo" on={ch.solo} onClick={() => s.dispatch({ type: 'channel.solo.toggle', args: { id: ch.id } })} small>
          {s.monitor.soloMode === 'pfl' ? 'PFL' : 'AFL'}
        </Toggle>
      </>
    );
    meter = <Meter id={ch.id} height={faderH} />;
    fader = <Fader db={ch.faderDb} onChange={(db) => setStripFader(refr, db)} color={ch.color} height={faderH} />;
    dbText = formatDb(ch.faderDb);
    mute = (
      <button
        className={'mute-btn' + (ch.mute ? ' on' : '') + (mr.muted && !mr.self ? ' group' : '')}
        onClick={() => s.dispatch({ type: 'channel.mute.toggle', args: { id: ch.id } })}
        title={mr.muted && !mr.self ? `Muted by ${[...mr.groups, ...mr.dcas].join(', ')}` : 'Mute'}
      >
        MUTE
      </button>
    );
  } else if (refr.kind === 'bus') {
    const b = s.buses.find((x) => x.id === refr.id);
    if (!b) return null;
    const mr = busMuteReason(s, b);
    cls += ' bus';
    head = (
      <div className="strip-head" draggable title="Drag to move this strip" style={{ background: b.color }}>
        <span className="strip-num">{b.type === 'mixminus' ? 'N-1' : 'MIX'}</span>
        <span className="strip-name">{b.name}</span>
      </div>
    );
    sections = (
      <>
        <div className="sec sec-input"><div className="sec-src">{b.type === 'mixminus' ? 'N-1' : 'BUS'}</div></div>
        <RackSection inserts={b.inserts} onSelect={select} />
        <SendsSection />
        <div className="sec sec-pan" />
        <div className="sec sec-groups" />
      </>
    );
    buttons = (
      <>
        <Toggle kind="sel" on={selected} onClick={select} small>SEL</Toggle>
        <Toggle kind="solo" on={b.solo} onClick={() => s.updateBus(b.id, { solo: !b.solo })} small>
          {s.monitor.soloMode === 'pfl' ? 'PFL' : 'AFL'}
        </Toggle>
      </>
    );
    meter = <Meter id={b.id} height={faderH} stereo />;
    fader = <Fader db={b.faderDb} onChange={(db) => setStripFader(refr, db)} color={b.color} height={faderH} />;
    dbText = formatDb(b.faderDb);
    mute = (
      <button className={'mute-btn' + (b.mute ? ' on' : '') + (mr.muted && !mr.self ? ' group' : '')} onClick={() => s.dispatch({ type: 'bus.mute.toggle', args: { id: b.id } })}>
        MUTE
      </button>
    );
  } else if (refr.kind === 'dca') {
    const d = s.dcas.find((x) => x.id === refr.id);
    if (!d) return null;
    const members = s.channels.filter((c) => c.dcas.includes(d.id));
    cls += ' dca';
    head = (
      <div className="strip-head" draggable title="Drag to move this strip" style={{ background: d.color }}>
        <span className="strip-num">DCA</span>
        <span className="strip-name">{d.name}</span>
      </div>
    );
    sections = (
      <>
        <div className="sec sec-input"><div className="sec-src" title={members.map((m) => m.name).join(', ')}>{members.length} CH</div></div>
        <RackSection />
        <SendsSection />
        <div className="sec sec-pan" />
        <div className="sec sec-groups" />
      </>
    );
    buttons = <Toggle kind="sel" on={selected} onClick={select} small>SEL</Toggle>;
    meter = <div className="meter-spacer" />;
    fader = <Fader db={d.faderDb} onChange={(db) => setStripFader(refr, db)} color={d.color} height={faderH} />;
    dbText = formatDb(d.faderDb);
    mute = (
      <button className={'mute-btn' + (d.mute ? ' on' : '')} onClick={() => s.dispatch({ type: 'dca.mute.toggle', args: { id: d.id } })}>
        MUTE
      </button>
    );
  } else {
    cls += ' main';
    head = (
      <div className="strip-head" draggable title="Drag to move this strip" style={{ background: '#c9ccd1', color: '#111' }}>
        <span className="strip-num">PGM</span>
        <span className="strip-name">Main LR</span>
      </div>
    );
    sections = (
      <>
        <div className="sec sec-input"><div className="sec-src">PGM</div></div>
        <RackSection inserts={s.main.inserts} onSelect={select} />
        <SendsSection />
        <div className="sec sec-pan" />
        <div className="sec sec-groups" />
      </>
    );
    buttons = <Toggle kind="sel" on={selected} onClick={select} small>SEL</Toggle>;
    meter = <Meter id="main" height={faderH} stereo />;
    fader = <Fader db={s.main.faderDb} onChange={(db) => setStripFader(refr, db)} color="#fff" height={faderH} />;
    dbText = formatDb(s.main.faderDb);
    mute = (
      <button className={'mute-btn' + (s.main.mute ? ' on' : '')} onClick={() => s.dispatch({ type: 'main.mute.toggle', args: {} })}>
        MUTE
      </button>
    );
  }

  return (
    <div className={cls + (selected ? ' selected' : '')} onClick={onStripClick}>
      {head}
      {sections}
      <div className="strip-btns">{buttons}</div>
      <div className="strip-body" ref={bodyRef}>
        {meter}
        {fader}
      </div>
      <div className="strip-db">{dbText}</div>
      {mute}
    </div>
  );
}
