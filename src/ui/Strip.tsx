import { useEffect, useRef, useState } from 'react';
import { busMuteReason, channelMuteReason, formatDb } from '../core/mix';
import { defaultParams, getPlugin, type PluginDescriptor } from '../core/plugins';
import { newId } from '../core/defaults';
import { PluginPicker } from './PluginPicker';
import { linkInfo } from '../core/links';
import { useConsole } from '../core/store';
import type { Bus, Channel, InsertSlot, Send, StripRef } from '../core/types';
import { applyTapValue, sendTap, tapChoices, tapCode, tapValue } from '../core/sends';
import { Fader, Knob, Meter, MeterScale, PeakReadout, Toggle } from './controls';
import { setStripFader } from '../control/midi';
import { createsLoop } from '../core/plan';
import { createBus, createdBuses, isCreated, routableBuses } from '../core/buses';
import { sendNative, useNative } from '../native/bridge';
import { closeDrawer, openDrawer, toggleRack, useUi } from './uiState';

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
  !!(t as HTMLElement | null)?.closest?.('button, input, select, .fader-cap, .knob, .rack-slot, .send-row, .out-pill, .plugin-picker');

// ------------------------------------------------------------------ strip sections
function sourceLabel(ch: Channel) {
  if (ch.inputMode === 'playback') return 'PB';
  switch (ch.source.kind) {
    case 'input': {
      const l = (ch.source.deviceChannel ?? 0) + 1;
      return ch.stereo ? `IN ${l}/${(ch.source.deviceChannelR ?? l) + 1}` : `IN ${l}`;
    }
    case 'tone':
      return 'TONE';
    case 'noise':
      return 'NOISE';
    case 'speech':
      return 'SPEECH';
    default:
      return '—';
  }
}

/** Logic-style mono / stereo switch: one circle (mono) or two linked circles (stereo). */
export function MonoStereoSwitch({ ch, size = 16 }: { ch: Channel; size?: number }) {
  const s = useConsole();
  const st = !!ch.stereo;
  return (
    <button
      className={'ms-switch' + (st ? ' stereo' : '')}
      title={st ? 'Stereo channel (click for mono)' : 'Mono channel (click for stereo)'}
      onClick={(e) => {
        e.stopPropagation();
        // switching to stereo on an interface input takes the next input as the right side
        s.updateChannel(ch.id, st ? { stereo: false } : { stereo: true, pan: 0, source: { ...ch.source, deviceChannelR: undefined } });
      }}
    >
      <svg width={size} height={size * 0.7} viewBox="0 0 20 14">
        {st ? (
          <>
            <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="13" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          </>
        ) : (
          <circle cx="10" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        )}
      </svg>
    </button>
  );
}

const gainColor = (db: number) => (db > 0.05 ? '#f2a33c' : db < -0.05 ? '#3cc6d9' : '#8b929b');

/** The strip's input label is also a menu: pick an interface input (or a test source) right here. */
function InputSection({ ch }: { ch: Channel }) {
  const s = useConsole();
  const device = useNative((st) => (st.status === 'connected' ? st.device : undefined));
  const value = ch.source.kind === 'input' ? `in:${ch.source.deviceChannel ?? 0}` : ch.source.kind;
  const choose = (v: string) => {
    if (v.startsWith('in:'))
      s.updateChannel(ch.id, { source: { ...ch.source, kind: 'input', deviceId: device ? 'native' : ch.source.deviceId, deviceChannel: Number(v.slice(3)), deviceChannelR: undefined } });
    else s.updateChannel(ch.id, { source: { ...ch.source, kind: v as Channel['source']['kind'] } });
  };
  const inputs = device?.inputs ?? [];
  return (
    <div className="sec sec-input">
      <div className="src-row">
      <MonoStereoSwitch ch={ch} />
      <div className="sec-src pickable" title={`Input: ${sourceLabel(ch)}. Click to change`} onClick={(e) => e.stopPropagation()}>
        {sourceLabel(ch)}
        {ch.phaseInvert && <span className="phase">Ø</span>}
        <select className="src-select" value={value} onChange={(e) => choose(e.target.value)}>
          <option value="none">— No source</option>
          {inputs.length > 0 && (
            <optgroup label={device?.inputDevice || 'Interface inputs'}>
              {inputs.map((name, i) =>
                ch.stereo ? (
                  i + 1 < inputs.length && (
                    <option key={i} value={`in:${i}`}>
                      IN {i + 1}/{i + 2}{name && name !== `In ${i + 1}` ? ` · ${name}` : ''}
                    </option>
                  )
                ) : (
                  <option key={i} value={`in:${i}`}>
                    IN {i + 1}{name && name !== `In ${i + 1}` ? ` · ${name}` : ''}
                  </option>
                ),
              )}
            </optgroup>
          )}
          {!inputs.length && ch.source.kind === 'input' && <option value={value}>{sourceLabel(ch)}</option>}
          <optgroup label="Test sources">
            <option value="tone">Test tone</option>
            <option value="noise">Pink noise</option>
            <option value="speech">Speech sim</option>
          </optgroup>
        </select>
      </div>
      </div>
      <Knob
        size={30}
        value={ch.gainDb}
        min={-24}
        max={48}
        defaultValue={0}
        // gain colour: amber when boosting, cyan when cutting, grey at 0 dB
        color={gainColor(ch.gainDb)}
        valueColor={Math.abs(ch.gainDb) < 0.05 ? undefined : gainColor(ch.gainDb)}
        format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
        onChange={(gainDb) => s.updateChannel(ch.id, { gainDb: Math.abs(gainDb) < 0.3 ? 0 : gainDb })}
      />
    </div>
  );
}

/** Rack slots: click a plugin to open (or close) its own floating window;
 *  click the next empty slot to pick a plugin for it. */
function RackSection({ inserts, onSelect, onAdd, onBypass }: { inserts?: InsertSlot[]; onSelect?: () => void; onAdd?: (p: PluginDescriptor) => void; onBypass?: (slotId: string) => void }) {
  const hidden = useUi((u) => u.rackHidden);
  const nativeOn = useNative((st) => st.status === 'connected');
  const native = useNative((st) => st.inserts);
  const [picker, setPicker] = useState<DOMRect | null>(null);
  const click = (e: React.MouseEvent, ins?: InsertSlot) => {
    if (!ins) {
      if (onAdd) setPicker((e.currentTarget as HTMLElement).getBoundingClientRect());
      return;
    }
    if (nativeOn && !ins.pluginId.startsWith('builtin.')) {
      sendNative({ type: 'insert.editor', slotId: ins.id, open: !native[ins.id]?.editorOpen });
      return;
    }
    onSelect?.(); // browser effect: its settings are in the drawer's RACK tab
  };
  const slots = Array.from({ length: 8 }, (_, i) => inserts?.[i]);
  const nextFree = inserts ? inserts.length : -1;
  if (hidden) {
    const n = inserts?.length ?? 0;
    const open = inserts?.some((x) => native[x.id]?.editorOpen);
    return (
      <div
        className={'sec sec-rack folded' + (n ? ' used' : '') + (open ? ' open' : '')}
        title={inserts ? `${n} plugin${n === 1 ? '' : 's'} (rack hidden): click to show the rack` : ''}
        onClick={(e) => {
          if (!inserts) return;
          e.stopPropagation();
          toggleRack();
        }}
      >
        {inserts ? (n ? `FX ${n}` : '') : ''}
      </div>
    );
  }
  return (
    <div className="sec sec-rack">
      {inserts &&
        slots.map((ins, i) => {
          const name = ins ? getPlugin(ins.pluginId)?.name ?? ins.pluginName ?? 'Plugin' : '';
          const n = ins ? native[ins.id] : undefined;
          const isWin = !!ins && nativeOn && !ins.pluginId.startsWith('builtin.');
          const addable = !ins && i === nextFree && !!onAdd;
          return (
            <div
              key={i}
              className={'rack-slot' + (ins ? ' used' : '') + (addable ? ' add' : '') + (ins?.bypass ? ' byp' : '') + (n?.editorOpen ? ' open' : '') + (n?.error ? ' err' : '')}
              title={
                ins
                  ? `${name}${ins.bypass ? ' (bypassed)' : ''}${n?.error ? ` — ${n.error}` : ''} — ${isWin ? (n?.editorOpen ? 'click to close its window' : 'click to open its window') : 'click for settings'}`
                  : addable ? 'Click to add a plugin' : ''
              }
              onClick={(e) => click(e, ins)}
            >
              {ins && (
                <span
                  className="rs-dot"
                  role="switch"
                  aria-checked={!ins.bypass}
                  title={ins.bypass ? `${name} is bypassed: click to turn it on` : `${name} is on: click to bypass`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onBypass?.(ins.id);
                  }}
                />
              )}
              {ins ? name : addable ? '+' : ''}
              {ins?.recallSafe && <span className="rs-lock" title="Recall safe">🔒</span>}
            </div>
          );
        })}
      {picker && onAdd && (
        <PluginPicker
          anchor={picker}
          onClose={() => setPicker(null)}
          onPick={(p) => {
            setPicker(null);
            onAdd(p);
          }}
        />
      )}
    </div>
  );
}

/** Add a plugin to the end of a rack (and open its window once it has loaded). */
export function newInsert(p: PluginDescriptor): InsertSlot {
  return { id: newId('ins'), pluginId: p.id, pluginName: p.name, bypass: false, params: defaultParams(p) };
}

const sendUsed = (snd?: { on: boolean; levelDb: number }) => !!snd && (snd.on || isFinite(snd.levelDb));
const stop = (e: React.SyntheticEvent) => e.stopPropagation();
const pluginName = (id: string, fallback?: string) => getPlugin(id)?.name ?? fallback ?? 'Plugin';

/** One send on the strip (like Logic): the bus name over its level, and its tap point beside it.
 *  Drag sideways for level, double-click on/off; the tap code opens the menu (tap point, on/off,
 *  change bus, remove). */
export function SendRow({ ch, b }: { ch: Channel; b: Bus }) {
  const s = useConsole();
  const snd: Send = ch.sends[b.id] ?? { on: false, levelDb: -Infinity, pre: false };
  const drag = useRef<{ x: number; db: number } | null>(null);
  const setSends = (sends: Channel['sends']) => s.updateChannel(ch.id, { sends });
  const set = (p: Partial<Send>) => setSends({ ...ch.sends, [b.id]: { ...snd, ...p } });
  const frac = isFinite(snd.levelDb) ? Math.max(0, Math.min(1, (snd.levelDb + 60) / 70)) : 0;
  const db = isFinite(snd.levelDb) ? `${snd.levelDb > 0 ? '+' : ''}${snd.levelDb.toFixed(1)} dB` : '-∞';
  const tap = sendTap(snd);
  const code = tapCode(ch, snd);
  const tapName = tapChoices(ch, pluginName).find((c) => c.value === tapValue(snd))?.label ?? code;
  const menu = (v: string) => {
    if (v === 'toggle') set({ on: !snd.on, levelDb: isFinite(snd.levelDb) ? snd.levelDb : 0 });
    else if (v.startsWith('tap:')) setSends({ ...ch.sends, [b.id]: applyTapValue(snd, v.slice(4)) });
    else if (v === 'remove') {
      const { [b.id]: _gone, ...rest } = ch.sends;
      setSends(rest);
    } else if (v.startsWith('to:')) {
      const { [b.id]: _gone, ...rest } = ch.sends;
      setSends({ ...rest, [v.slice(3)]: snd });
    }
  };
  return (
    <div className={`send-row tap-${tap}` + (snd.on ? ' on' : '')} onClick={stop}>
      <div
        className="sr-bar"
        title={`Send to ${b.name}: ${db}${snd.on ? '' : ' (off)'}. Tap: ${tapName}. Drag sideways for level, double-click on/off.`}
        onPointerDown={(e) => {
          e.stopPropagation();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, db: isFinite(snd.levelDb) ? snd.levelDb : -60 };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const next = Math.max(-60, Math.min(10, drag.current.db + (e.clientX - drag.current.x) * (e.shiftKey ? 0.1 : 0.5)));
          set({ levelDb: next <= -60 ? -Infinity : Math.round(next * 2) / 2, on: true });
        }}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={() => menu('toggle')}
      >
        <span className="sr-fill" style={{ width: `${frac * 100}%` }} />
        <span className="sr-name">{b.name}</span>
      </div>
      <span className="sr-tap" title={`Tap: ${tapName}. Click for options`}>
        {code}
        <select value="" onChange={(e) => menu(e.target.value)}>
          <option value="" disabled>{b.name} · {db}</option>
          <optgroup label="Tap point">
            {tapChoices(ch, pluginName).map((c) => (
              <option key={c.value} value={`tap:${c.value}`}>{c.value === tapValue(snd) ? '✓ ' : '    '}{c.label}</option>
            ))}
          </optgroup>
          <optgroup label="Send">
            <option value="toggle">{snd.on ? 'Turn send off' : 'Turn send on'}</option>
            <option value="remove">Remove send</option>
          </optgroup>
          <optgroup label="Change to bus">
            {routableBuses(s)
              .filter((x) => x.type !== 'mixminus' && x.id !== b.id && !sendUsed(ch.sends[x.id]))
              .map((x) => <option key={x.id} value={`to:${x.id}`}>{x.id.slice(3)} · {x.name}</option>)}
          </optgroup>
        </select>
      </span>
    </div>
  );
}

/** Sends listed on the strip by bus name, plus an empty slot to add one. */
export function SendsSection({ ch }: { ch?: Channel }) {
  const s = useConsole();
  if (!ch) return <div className="sec sec-sends" />;
  const used = routableBuses(s).filter((b) => sendUsed(ch.sends[b.id]));
  const mm = createdBuses(s).filter((b) => b.type === 'mixminus');
  return (
    <div className="sec sec-sends">
      {used.map((b) => <SendRow key={b.id} ch={ch} b={b} />)}
      {mm.map((b) => (
        <div key={b.id} className={'send-row auto' + (ch.mainAssign && b.mixMinusExclude !== ch.id ? ' on' : '')} title={`${b.name}: mix-minus (automatic)`}>
          <div className="sr-bar"><span className="sr-fill" style={{ width: '100%' }} /><span className="sr-name">{b.name}</span></div>
        </div>
      ))}
      <div className="send-row add" onClick={stop} title="Add a send to a bus">
        <span className="sr-name">+ send</span>
        <select
          value=""
          onChange={(e) => {
            let id = e.target.value;
            if (!id) return;
            if (id === 'new') {
              // a new aux / IEM bus, fed by this send (name it in the bus panel)
              const st = useConsole.getState();
              const made = createBus(st, 'aux');
              if (!made.id) return;
              st.update(() => made.patch);
              id = made.id;
            }
            const st = useConsole.getState();
            const c = st.channels.find((x) => x.id === ch.id)!;
            st.updateChannel(ch.id, { sends: { ...c.sends, [id]: { on: true, levelDb: 0, pre: false, tap: 'post' } } });
          }}
        >
          <option value="" disabled>Send to…</option>
          <option value="new">+ New bus (aux / IEM)…</option>
          {routableBuses(s)
            .filter((b) => b.type !== 'mixminus' && !sendUsed(ch.sends[b.id]))
            .map((b) => <option key={b.id} value={b.id}>{b.id.slice(3)} · {b.name}</option>)}
        </select>
      </div>
    </div>
  );
}

/** The channel's output, shown and changed right on the strip (Main LR and/or buses). */
export function ChannelOutput({ ch }: { ch: Channel }) {
  const s = useConsole();
  const routes = ch.routes ?? [];
  const names = [...(ch.mainAssign ? ['Main LR'] : []), ...routes.map((id) => s.buses.find((b) => b.id === id)?.name ?? id)];
  const label = names.length === 0 ? 'No output' : names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
  const choose = (v: string) => {
    if (v === 'new') {
      // a new group bus with this channel assigned (and Main LR off)
      const st = useConsole.getState();
      const made = createBus(st, 'group');
      if (!made.id) return;
      st.update(() => made.patch);
      st.updateChannel(ch.id, { mainAssign: false, routes: [...routes, made.id] });
      return;
    }
    if (v === 'main') s.updateChannel(ch.id, { mainAssign: !ch.mainAssign });
    else if (v === 'only-main') s.updateChannel(ch.id, { mainAssign: true, routes: [] });
    else if (v.startsWith('only:')) s.updateChannel(ch.id, { mainAssign: false, routes: [v.slice(5)] });
    else s.updateChannel(ch.id, { routes: routes.includes(v) ? routes.filter((x) => x !== v) : [...routes, v] });
  };
  const buses = routableBuses(s);
  return (
    <div className="sec sec-out">
      <div className={'out-pill pickable' + (names.length === 0 ? ' none' : '')} title={`Output: ${names.join(', ') || 'none'}. Click to change`} onClick={stop}>
        {label}
        <select value="" onChange={(e) => choose(e.target.value)}>
          <option value="" disabled>Output (✓ = on, pick to switch on/off)</option>
          <option value="main">{ch.mainAssign ? '✓ ' : '    '}Main LR</option>
          <optgroup label="Buses">
            {buses.map((b) => <option key={b.id} value={b.id}>{routes.includes(b.id) ? '✓ ' : '    '}{b.id.slice(3)} · {b.name}</option>)}
          </optgroup>
          <option value="new">+ New group bus (this channel only)…</option>
          <optgroup label="Only this output">
            <option value="only-main">Main LR only</option>
            {buses.map((b) => <option key={b.id} value={`only:${b.id}`}>{b.name} only</option>)}
          </optgroup>
        </select>
      </div>
    </div>
  );
}

/** A bus's output on its strip: Main LR, another bus, or physical outputs only. */
function BusOutput({ b }: { b: Bus }) {
  const s = useConsole();
  if (b.type === 'mixminus') return <div className="sec sec-out"><div className="out-pill">N-1 out</div></div>;
  const out = b.output ?? 'none';
  const label = out === 'main' ? 'Main LR' : out === 'none' ? 'Outputs' : s.buses.find((x) => x.id === out)?.name ?? out;
  return (
    <div className="sec sec-out">
      <div className="out-pill pickable" title={`Output: ${out === 'none' ? 'physical outputs only (patch on the I/O page)' : label}. Click to change`} onClick={stop}>
        {label}
        <select value={out} onChange={(e) => s.updateBus(b.id, { output: e.target.value })}>
          <option value="main">Main LR</option>
          <option value="none">Outputs only (patch on I/O)</option>
          <optgroup label="Another bus">
            {routableBuses(s)
              .filter((x) => x.id !== b.id && x.type !== 'mixminus' && !createsLoop(s, b.id, x.id))
              .map((x) => <option key={x.id} value={x.id}>{x.id.slice(3)} · {x.name}</option>)}
          </optgroup>
        </select>
      </div>
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
  const select = () => {
    // selecting a strip opens its settings drawer; selecting it again closes the drawer
    if (useUi.getState().mode === 'pinned') return s.select(refr); // the channel panel is always open
    if (selected && useUi.getState().drawerOpen) return closeDrawer();
    s.select(refr);
    openDrawer();
  };
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
      <div className="strip-head" draggable title="Drag to move this strip" style={{ '--cc': ch.color } as React.CSSProperties}>
        <span className="strip-num">
          {ch.id.replace('ch', '').padStart(2, '0')}
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
        <RackSection inserts={ch.inserts} onSelect={select} onBypass={(id) => s.updateChannel(ch.id, { inserts: ch.inserts.map((x) => (x.id === id ? { ...x, bypass: !x.bypass } : x)) })} onAdd={(p) => s.updateChannel(ch.id, { inserts: [...ch.inserts, newInsert(p)] })} />
        <SendsSection ch={ch} />
        <ChannelOutput ch={ch} />
        <div className="sec sec-pan">
          <Knob size={30} value={ch.pan} min={-1} max={1} defaultValue={0} format={ch.stereo ? (p) => `BAL ${panText(p)}` : panText} onChange={(pan) => s.updateChannel(ch.id, { pan: Math.abs(pan) < 0.02 ? 0 : pan })} />
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
        <Toggle kind="solo" on={ch.solo} onClick={() => s.dispatch({ type: 'channel.solo.toggle', args: { id: ch.id } })} small>
          {s.monitor.soloMode === 'pfl' ? 'PFL' : 'AFL'}
        </Toggle>
      </>
    );
    meter = <><MeterScale height={faderH} /><Meter id={ch.id} height={faderH} stereo={!!ch.stereo} /></>;
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
    if (!isCreated(b)) return <div className="strip empty" title="This bus hasn't been created (New bus in I/O)"><div className="strip-num">{index + 1}</div></div>;
    const mr = busMuteReason(s, b);
    cls += ' bus';
    head = (
      <div className="strip-head" draggable title="Drag to move this strip" style={{ '--cc': b.color } as React.CSSProperties}>
        <span className="strip-num">{b.type === 'mixminus' ? 'N-1' : 'MIX'}</span>
        <span className="strip-name">{b.name}</span>
      </div>
    );
    sections = (
      <>
        <div className="sec sec-input"><div className="sec-src">{b.type === 'mixminus' ? 'N-1' : 'BUS'}</div></div>
        <RackSection inserts={b.inserts} onSelect={select} onBypass={(id) => s.updateBus(b.id, { inserts: b.inserts.map((x) => (x.id === id ? { ...x, bypass: !x.bypass } : x)) })} onAdd={(p) => s.updateBus(b.id, { inserts: [...b.inserts, newInsert(p)] })} />
        <SendsSection />
        <BusOutput b={b} />
        <div className="sec sec-pan" />
        <div className="sec sec-groups" />
      </>
    );
    buttons = (
      <>
        <Toggle kind="solo" on={b.solo} onClick={() => s.updateBus(b.id, { solo: !b.solo })} small>
          {s.monitor.soloMode === 'pfl' ? 'PFL' : 'AFL'}
        </Toggle>
      </>
    );
    meter = <><MeterScale height={faderH} /><Meter id={b.id} height={faderH} stereo /></>;
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
      <div className="strip-head" draggable title="Drag to move this strip" style={{ '--cc': d.color } as React.CSSProperties}>
        <span className="strip-num">DCA</span>
        <span className="strip-name">{d.name}</span>
      </div>
    );
    sections = (
      <>
        <div className="sec sec-input"><div className="sec-src" title={members.map((m) => m.name).join(', ')}>{members.length} CH</div></div>
        <RackSection />
        <SendsSection />
        <div className="sec sec-out" />
        <div className="sec sec-pan" />
        <div className="sec sec-groups" />
      </>
    );
    buttons = null;
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
      <div className="strip-head" draggable title="Drag to move this strip" style={{ '--cc': '#c9ccd1' } as React.CSSProperties}>
        <span className="strip-num">PGM</span>
        <span className="strip-name">Main LR</span>
      </div>
    );
    sections = (
      <>
        <div className="sec sec-input"><div className="sec-src">PGM</div></div>
        <RackSection inserts={s.main.inserts} onSelect={select} onBypass={(id) => s.updateMain({ inserts: s.main.inserts.map((x) => (x.id === id ? { ...x, bypass: !x.bypass } : x)) })} onAdd={(p) => s.updateMain({ inserts: [...s.main.inserts, newInsert(p)] })} />
        <SendsSection />
        <div className="sec sec-out"><div className="out-pill" title="Main LR goes to the physical outputs patched on the I/O page">Outputs</div></div>
        <div className="sec sec-pan" />
        <div className="sec sec-groups" />
      </>
    );
    buttons = null;
    meter = <><MeterScale height={faderH} /><Meter id="main" height={faderH} stereo /></>;
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
      <div className="strip-foot">
        {refr.kind !== 'dca' ? <PeakReadout id={refr.kind === 'main' ? 'main' : refr.id} /> : <span className="peak-readout" data-zone="off" />}
        <span className="strip-db" title="Fader level (dB)">{dbText}</span>
      </div>
      {mute}
    </div>
  );
}
