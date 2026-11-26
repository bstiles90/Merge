// Record workspace timeline: tracks (main mix + channels) with their recordings, transport,
// loop, markers, horizontal and vertical zoom. Track names and lanes are one row each, so
// they always stay lined up however far you scroll; only what's on screen is drawn.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { encodeWav, getMedia, importAudioFile, onMediaChange } from '../audio/media';
import { getEngine } from '../audio/engine';
import { newId } from '../core/defaults';
import { services } from '../core/services';
import { useConsole } from '../core/store';
import type { Clip } from '../core/types';
import { Toggle } from './controls';
import { bootEngine } from './useEngine';
import { sendNative, useNative } from '../native/bridge';

const HEAD = 200; // track name column (px)
const RULER = 26;

export function fmtTime(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}
const fmtTick = (t: number, step: number) => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const sec = step < 1 ? s.toFixed(1).padStart(4, '0') : String(Math.round(s)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

interface View {
  left: number; // scroll position (lane px)
  width: number; // visible lane width (px)
}

function ClipView({ clip, pps, h, view, selected, onSelect }: { clip: Clip; pps: number; h: number; view: View; selected: boolean; onSelect: () => void }) {
  const s = useConsole();
  const ref = useRef<HTMLCanvasElement>(null);
  const [mediaVer, setMediaVer] = useState(0);
  useEffect(() => onMediaChange(() => setMediaVer((v) => v + 1)), []);
  const x0 = clip.start * pps;
  const w = Math.max(2, clip.duration * pps);
  // draw only the part of the clip that's on screen (an hour-long take is huge at high zoom)
  const va = clamp(view.left - x0, 0, w), vb = clamp(view.left + view.width - x0, 0, w);
  const cw = Math.ceil(vb - va);
  const ch = Math.max(6, h - (h >= 34 ? 18 : 6));
  useEffect(() => {
    const cv = ref.current;
    const m = getMedia(clip.bufferId);
    if (!cv || cw <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = cw * dpr;
    cv.height = ch * dpr;
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    if (!m) return;
    g.fillStyle = 'rgba(255,255,255,0.78)';
    const per = m.peaksPerSecond / pps; // peaks per pixel
    const start = (clip.offset + va / pps) * m.peaksPerSecond;
    for (let x = 0; x < cw; x++) {
      let mx = 0;
      const a = Math.floor(start + x * per), b = Math.max(a + 1, Math.floor(start + (x + 1) * per));
      for (let i = a; i < b && i < m.peaks.length; i++) mx = Math.max(mx, m.peaks[i]);
      const ph = Math.max(0.5, mx * ch);
      g.fillRect(x, (ch - ph) / 2, 1, ph);
    }
  }, [clip, pps, va, cw, ch, mediaVer]);

  const drag = useRef<{ x: number; start: number } | null>(null);
  const color = s.channels.find((c) => c.id === clip.trackId)?.color ?? '#8d8d8d';
  const offline = !clip.file && !getMedia(clip.bufferId);
  return (
    <div
      className={'clip' + (selected ? ' selected' : '') + (offline ? ' offline' : '')}
      style={{ left: x0, width: w, background: color + '88', borderColor: color }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, start: clip.start };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const start = Math.max(0, drag.current.start + (e.clientX - drag.current.x) / pps);
        s.update((st) => ({ clips: st.clips.map((c) => (c.id === clip.id ? { ...c, start } : c)) }));
      }}
      onPointerUp={() => (drag.current = null)}
      title={offline ? 'Audio not loaded (browser recordings are kept in memory for this session)' : clip.file ?? clip.name}
    >
      {h >= 34 && (
        <div className="clip-name" style={{ marginLeft: va }}>
          {clip.name}
          {offline ? ' (offline)' : ''}
        </div>
      )}
      {cw > 0 && <canvas ref={ref} style={{ left: va, width: cw, height: ch }} />}
    </div>
  );
}

export function TimelineView() {
  const s = useConsole();
  const native = useNative((n) => n.status === 'connected');
  const [pps, setPps] = useState(20); // horizontal zoom: pixels per second
  const [trackH, setTrackH] = useState(44); // vertical zoom
  const [sel, setSel] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [view, setView] = useState<View>({ left: 0, width: 1000 });
  const playheadRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importTrack, setImportTrack] = useState<string | null>(null);
  const pendingScroll = useRef<number | null>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const t = services.playhead();
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${HEAD + t * pps}px)`;
      if (timeRef.current) timeRef.current.textContent = fmtTime(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pps]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !(e.target as HTMLElement).closest?.('input, textarea, select')) {
        s.update((st) => ({ clips: st.clips.filter((c) => c.id !== sel) }));
        setSel(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, s]);

  // what's on screen (drawn lazily: ticks and waveforms only there)
  const measure = () => {
    const el = scrollRef.current;
    if (el) setView({ left: el.scrollLeft, width: Math.max(0, el.clientWidth - HEAD) });
  };
  useEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (scrollRef.current) ro.observe(scrollRef.current);
    return () => ro.disconnect();
  }, []);
  // apply a zoom's scroll position after the new width is laid out
  useLayoutEffect(() => {
    if (pendingScroll.current !== null && scrollRef.current) {
      scrollRef.current.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
    measure();
  }, [pps]);

  const loop = s.transport.loop;
  // at least the window's width, so the lanes always fill it
  const length = Math.max(60, view.width / pps, ...s.clips.map((c) => c.start + c.duration + 10), services.playhead() + 10, loop ? loop.end + 10 : 0);
  const tracks = [
    { id: 'pgm', name: 'Main mix (PGM)', color: '#c9ccd1' },
    ...s.channels
      .filter((c) => showAll || c.source.kind !== 'none' || c.recArm || c.inputMode === 'playback' || s.clips.some((x) => x.trackId === c.id))
      .map((c) => ({ id: c.id, name: c.name, color: c.color })),
  ];
  const chTracks = s.channels.filter((c) => tracks.some((t) => t.id === c.id));
  const seek = (t: number) => s.update((st) => ({ transport: { ...st.transport, position: Math.max(0, t) } }));
  const selected = s.clips.find((c) => c.id === sel);

  // zoom keeping the time under `anchor` (viewport px from the lanes' left edge) in place
  const zoomTo = (next: number, anchor = view.width / 2) => {
    const z = clamp(next, 0.05, 400);
    const t = (view.left + anchor) / pps;
    pendingScroll.current = Math.max(0, t * z - anchor);
    setPps(z);
  };
  const contentEnd = Math.max(10, ...s.clips.map((c) => c.start + c.duration), loop ? loop.end : 0);
  const fitH = () => zoomTo(Math.max(0.05, (view.width - 20) / contentEnd), 0);
  const fitV = () => {
    const el = scrollRef.current;
    if (el) setTrackH(clamp(Math.floor((el.clientHeight - RULER - 2) / tracks.length), 20, 160));
  };
  // ⌘/Ctrl + wheel: horizontal zoom at the pointer; Option + wheel: track height
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        zoomTo(pps * Math.exp(-e.deltaY * 0.004), clamp(e.clientX - r.left - HEAD, 0, view.width));
      } else if (e.altKey) {
        e.preventDefault();
        setTrackH((h) => clamp(Math.round(h * Math.exp(-e.deltaY * 0.004)), 20, 160));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  // ruler: click jumps there, drag across sets the loop
  const rulerDrag = useRef<{ x: number; t: number; moved: boolean } | null>(null);
  const timeAt = (clientX: number) => {
    const r = scrollRef.current!.getBoundingClientRect();
    return Math.max(0, (clientX - r.left - HEAD + view.left) / pps);
  };

  // ticks: about every 90 px, only those on screen
  const step = TICK_STEPS.find((x) => x * pps >= 90) ?? 3600;
  const t0 = Math.floor(view.left / pps / step) * step, t1 = (view.left + view.width) / pps;
  const ticks: number[] = [];
  for (let t = t0; t <= t1 + step && ticks.length < 400; t += step) ticks.push(Math.round(t * 1000) / 1000);

  const exportClip = (c: Clip) => {
    const m = getMedia(c.bufferId);
    if (!m || !m.data.length) return; // native clips are already WAV files on disk
    const url = URL.createObjectURL(encodeWav(m, c.offset, c.duration));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${c.name.replace(/[^\w#-]+/g, '_')}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const allArmed = chTracks.length > 0 && chTracks.every((c) => c.recArm);
  const withClips = s.channels.filter((c) => s.clips.some((x) => x.trackId === c.id));
  const vsc = withClips.length > 0 && withClips.every((c) => c.inputMode === 'playback');
  const anyMute = s.channels.some((c) => c.mute) || s.buses.some((b) => b.mute) || s.main.mute;
  const width = HEAD + length * pps;

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        <div className="tl-group">
          <span ref={timeRef} className="tl-time">00:00.00</span>
          <button title="Back to the start" onClick={() => s.dispatch({ type: 'transport.rtz', args: {} })}>⏮</button>
          <button className={s.transport.playing && !s.transport.recording ? 'on' : ''} onClick={() => s.dispatch({ type: 'transport.toggle', args: {} })}>
            {s.transport.playing ? '■ Stop' : '▶ Play'}
          </button>
          <button className={'rec-btn' + (s.transport.recording ? ' on' : '')} onClick={() => s.dispatch({ type: 'transport.record', args: {} })}>● Rec</button>
          <Toggle
            small
            on={!!loop?.on}
            title={loop ? `Loop ${fmtTime(loop.start)} – ${fmtTime(loop.end)} (drag across the ruler to change)` : 'Drag across the ruler to set a loop'}
            onClick={() => loop && s.update((st) => ({ transport: { ...st.transport, loop: { ...loop, on: !loop.on } } }))}
          >
            ⟳ LOOP
          </Toggle>
          <button onClick={() => s.dispatch({ type: 'marker.add', args: {} })}>+ Marker</button>
        </div>
        <div className="tl-group">
          <Toggle small kind="rec" on={allArmed} title="Arm every channel shown for recording (again: disarm all)"
            onClick={() => s.update((st) => ({ channels: st.channels.map((c) => (chTracks.some((t) => t.id === c.id) ? { ...c, recArm: !allArmed } : c)) }))}>
            ARM ALL
          </Toggle>
          <button disabled={!anyMute} title="Unmute every channel, bus and Main LR"
            onClick={() => s.update((st) => ({ channels: st.channels.map((c) => ({ ...c, mute: false })), buses: st.buses.map((b) => ({ ...b, mute: false })), main: { ...st.main, mute: false } }))}>
            Clear mutes
          </button>
        </div>
        <div className="tl-group">
          {native && (
            <button title="Put a multitrack's files on channels (matched by name, all starting together)" onClick={() => sendNative({ type: 'media.import', track: 'multitrack', multiple: true })}>
              Import multitrack…
            </button>
          )}
          <Toggle small on={vsc} title="Virtual soundcheck: every channel that has a recording plays it back instead of its live input"
            onClick={() => s.update((st) => ({ channels: st.channels.map((c) => (withClips.some((w) => w.id === c.id) ? { ...c, inputMode: vsc ? 'live' : 'playback' } : c)) }))}>
            VIRTUAL SOUNDCHECK
          </Toggle>
        </div>
        <div className="spacer" />
        {selected && (
          <div className="tl-group">
            <span className="hint">{selected.name} · {fmtTime(selected.duration)}</span>
            {!selected.file && <button onClick={() => exportClip(selected)}>Export WAV</button>}
            <button onClick={() => { s.update((st) => ({ clips: st.clips.filter((c) => c.id !== selected.id) })); setSel(null); }}>Delete</button>
          </div>
        )}
        <div className="tl-group seg" title="Which channels get a track">
          <button className={!showAll ? 'on' : ''} onClick={() => setShowAll(false)}>USED</button>
          <button className={showAll ? 'on' : ''} onClick={() => setShowAll(true)}>ALL {s.channels.length}</button>
        </div>
        <div className="tl-group tl-zoom" title="Zoom (⌘ + scroll: time · ⌥ + scroll: track height)">
          <span className="tl-zoom-l">TIME</span>
          <button onClick={() => zoomTo(pps / 1.6)}>−</button>
          <button onClick={fitH} title="Fit the whole session">FIT</button>
          <button onClick={() => zoomTo(pps * 1.6)}>+</button>
          <span className="tl-zoom-l">HEIGHT</span>
          <button onClick={() => setTrackH((h) => clamp(Math.round(h / 1.3), 20, 160))}>−</button>
          <button onClick={fitV} title="Fit every track">FIT</button>
          <button onClick={() => setTrackH((h) => clamp(Math.round(h * 1.3), 20, 160))}>+</button>
        </div>
        {!native && s.clips.some((c) => !c.file) && <button onClick={() => s.clips.forEach(exportClip)}>Export all stems</button>}
      </div>

      <div className="tl-scroll" ref={scrollRef} onScroll={measure}>
        <div className="tl-content" style={{ width, height: RULER + tracks.length * trackH }}>
          <div className="tl-row tl-ruler-row" style={{ height: RULER }}>
            <div className="tl-corner">TRACKS</div>
            <div
              className="tl-ruler"
              style={{ width: length * pps }}
              onPointerDown={(e) => {
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                rulerDrag.current = { x: e.clientX, t: timeAt(e.clientX), moved: false };
              }}
              onPointerMove={(e) => {
                const d = rulerDrag.current;
                if (!d) return;
                if (Math.abs(e.clientX - d.x) > 4) d.moved = true;
                if (!d.moved) return;
                const t = timeAt(e.clientX);
                s.update((st) => ({ transport: { ...st.transport, loop: { on: true, start: Math.min(d.t, t), end: Math.max(d.t, t) } } }));
              }}
              onPointerUp={(e) => {
                const d = rulerDrag.current;
                rulerDrag.current = null;
                if (d && !d.moved) seek(timeAt(e.clientX));
              }}
            >
              {loop && <div className={'tl-loop-bar' + (loop.on ? ' on' : '')} style={{ left: loop.start * pps, width: (loop.end - loop.start) * pps }} />}
              {ticks.map((t) => (
                <span key={t} className="tl-tick" style={{ left: t * pps }}>{fmtTick(t, step)}</span>
              ))}
              {s.markers.map((m) => (
                <span
                  key={m.id}
                  className="tl-marker"
                  style={{ left: m.time * pps }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    seek(m.time);
                  }}
                  onDoubleClick={() => s.update((st) => ({ markers: st.markers.filter((x) => x.id !== m.id) }))}
                  title="Click to jump, double-click to delete"
                >
                  {m.label}
                </span>
              ))}
            </div>
          </div>

          {tracks.map((t) => {
            const ch = s.channels.find((c) => c.id === t.id);
            return (
              <div key={t.id} className="tl-row" style={{ height: trackH }}>
                <div className={'tl-head' + (trackH < 34 ? ' slim' : '')} style={{ borderLeftColor: t.color }}>
                  <span className="tl-name" title={t.name}>{t.name}</span>
                  <div className="tl-btns">
                    {ch ? (
                      <>
                        <Toggle small kind="rec" on={ch.recArm} title="Arm for recording" onClick={() => s.updateChannel(ch.id, { recArm: !ch.recArm })}>R</Toggle>
                        <Toggle small on={ch.inputMode === 'playback'} onClick={() => s.updateChannel(ch.id, { inputMode: ch.inputMode === 'live' ? 'playback' : 'live' })} title="Input: live source, or playback of this track (virtual soundcheck)">
                          {ch.inputMode === 'live' ? 'LIVE' : '▶ PB'}
                        </Toggle>
                        <Toggle small kind="mute" on={ch.mute} onClick={() => s.dispatch({ type: 'channel.mute.toggle', args: { id: ch.id } })}>M</Toggle>
                        <button className="icon-btn" title="Import an audio file onto this track" onClick={() => { if (native) sendNative({ type: 'media.import', track: ch.id }); else { setImportTrack(ch.id); fileRef.current?.click(); } }}>⤓</button>
                      </>
                    ) : (
                      <Toggle small kind="rec" on={s.transport.recordProgram} title="Record the main mix (Main LR, after its fader) alongside the channels"
                        onClick={() => s.update((st) => ({ transport: { ...st.transport, recordProgram: !st.transport.recordProgram } }))}>R</Toggle>
                    )}
                  </div>
                </div>
                <div className="tl-lane" style={{ width: length * pps }} onPointerDown={() => setSel(null)}>
                  {s.clips
                    .filter((c) => c.trackId === t.id && c.start * pps < view.left + view.width + 50 && (c.start + c.duration) * pps > view.left - 50)
                    .map((c) => (
                      <ClipView key={c.id} clip={c} pps={pps} h={trackH} view={view} selected={c.id === sel} onSelect={() => setSel(c.id)} />
                    ))}
                </div>
              </div>
            );
          })}

          {loop?.on && <div className="tl-loop-shade" style={{ left: HEAD + loop.start * pps, width: (loop.end - loop.start) * pps }} />}
          {s.markers.map((m) => (
            <div key={m.id} className="tl-marker-line" style={{ left: HEAD + m.time * pps }} />
          ))}
          <div ref={playheadRef} className="tl-playhead" />
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file || !importTrack) return;
          const eng = getEngine() ?? (await bootEngine());
          const id = newId('buf');
          const m = await importAudioFile(eng.ctx, file, id);
          const dur = m.data[0].length / m.sampleRate;
          s.update((st) => ({
            clips: [
              ...st.clips,
              { id: newId('clip'), trackId: importTrack, name: file.name, start: services.playhead(), offset: 0, duration: dur, bufferId: id, channels: m.data.length },
            ],
          }));
        }}
      />
    </div>
  );
}
