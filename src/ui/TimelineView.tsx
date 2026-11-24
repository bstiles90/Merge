import { useEffect, useRef, useState } from 'react';
import { encodeWav, getMedia, importAudioFile, onMediaChange } from '../audio/media';
import { getEngine } from '../audio/engine';
import { newId } from '../core/defaults';
import { services } from '../core/services';
import { useConsole } from '../core/store';
import type { Clip } from '../core/types';
import { Toggle } from './controls';
import { bootEngine } from './useEngine';

const TRACK_H = 44;

export function fmtTime(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function ClipView({ clip, pps, selected, onSelect }: { clip: Clip; pps: number; selected: boolean; onSelect: () => void }) {
  const s = useConsole();
  const ref = useRef<HTMLCanvasElement>(null);
  const [mediaVer, setMediaVer] = useState(0);
  useEffect(() => {
    const off = onMediaChange(() => setMediaVer((v) => v + 1));
    return () => {
      off();
    };
  }, []);
  const w = Math.max(2, clip.duration * pps);
  useEffect(() => {
    const cv = ref.current;
    const m = getMedia(clip.bufferId);
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.min(w, 8000);
    cv.width = width * dpr;
    cv.height = (TRACK_H - 16) * dpr;
    const g = cv.getContext('2d')!;
    g.scale(dpr, dpr);
    const h = TRACK_H - 16;
    g.clearRect(0, 0, width, h);
    if (!m) return;
    g.fillStyle = 'rgba(255,255,255,0.75)';
    const start = clip.offset * m.peaksPerSecond;
    const per = m.peaksPerSecond / pps; // peaks per pixel
    for (let x = 0; x < width; x++) {
      let mx = 0;
      const a = Math.floor(start + x * per), b = Math.max(a + 1, Math.floor(start + (x + 1) * per));
      for (let i = a; i < b && i < m.peaks.length; i++) mx = Math.max(mx, m.peaks[i]);
      const ph = Math.max(0.5, mx * h);
      g.fillRect(x, (h - ph) / 2, 1, ph);
    }
  }, [clip, pps, w, mediaVer]);

  const drag = useRef<{ x: number; start: number } | null>(null);
  const color = s.channels.find((c) => c.id === clip.trackId)?.color ?? '#8d8d8d';
  const offline = !getMedia(clip.bufferId);
  return (
    <div
      className={'clip' + (selected ? ' selected' : '') + (offline ? ' offline' : '')}
      style={{ left: clip.start * pps, width: w, background: color + '99', borderColor: color }}
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
      title={offline ? 'Audio not loaded (recordings are kept in memory for this session)' : clip.name}
    >
      <div className="clip-name">{clip.name}{offline ? ' (offline)' : ''}</div>
      <canvas ref={ref} style={{ width: Math.min(w, 8000), height: TRACK_H - 16 }} />
    </div>
  );
}

export function TimelineView() {
  const s = useConsole();
  const [pps, setPps] = useState(20);
  const [sel, setSel] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const playheadRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importTrack, setImportTrack] = useState<string | null>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const t = services.playhead();
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${t * pps}px)`;
      if (timeRef.current) timeRef.current.textContent = fmtTime(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pps]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel && (e.target as HTMLElement).tagName !== 'INPUT') {
        s.update((st) => ({ clips: st.clips.filter((c) => c.id !== sel) }));
        setSel(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, s]);

  const tracks = [
    { id: 'pgm', name: 'PGM (Main LR)', color: '#c9ccd1' },
    ...s.channels
      .filter((c) => showAll || c.source.kind !== 'none' || c.recArm || s.clips.some((x) => x.trackId === c.id))
      .map((c) => ({ id: c.id, name: c.name, color: c.color })),
  ];
  const length = Math.max(120, ...s.clips.map((c) => c.start + c.duration + 30), services.playhead() + 30);
  const seek = (t: number) => s.update((st) => ({ transport: { ...st.transport, position: Math.max(0, t) } }));
  const selected = s.clips.find((c) => c.id === sel);

  const exportClip = (c: Clip) => {
    const m = getMedia(c.bufferId);
    if (!m) return;
    const url = URL.createObjectURL(encodeWav(m, c.offset, c.duration));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${c.name.replace(/[^\w#-]+/g, '_')}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        <span ref={timeRef} className="tl-time">00:00.00</span>
        <button onClick={() => s.dispatch({ type: 'transport.rtz', args: {} })}>⏮</button>
        <button className={s.transport.playing && !s.transport.recording ? 'on' : ''} onClick={() => s.dispatch({ type: 'transport.toggle', args: {} })}>
          {s.transport.playing ? '■ Stop' : '▶ Play'}
        </button>
        <button className={'rec-btn' + (s.transport.recording ? ' on' : '')} onClick={() => s.dispatch({ type: 'transport.record', args: {} })}>● Rec</button>
        <button onClick={() => s.dispatch({ type: 'marker.add', args: {} })}>+ Marker</button>
        <label className="row">
          <input
            type="checkbox"
            checked={s.transport.recordProgram}
            onChange={(e) => s.update((st) => ({ transport: { ...st.transport, recordProgram: e.target.checked } }))}
          />
          Record PGM
        </label>
        <label className="row">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> All tracks
        </label>
        <span className="hint">Zoom</span>
        <input type="range" min={2} max={200} value={pps} onChange={(e) => setPps(Number(e.target.value))} />
        <div className="spacer" />
        {selected && (
          <>
            <span className="hint">{selected.name} · {selected.duration.toFixed(1)}s</span>
            <button onClick={() => exportClip(selected)}>Export WAV</button>
            <button onClick={() => { s.update((st) => ({ clips: st.clips.filter((c) => c.id !== selected.id) })); setSel(null); }}>Delete</button>
          </>
        )}
        <button disabled={!s.clips.length} onClick={() => s.clips.forEach(exportClip)}>Export all stems</button>
      </div>
      <div className="tl-body" ref={scrollRef}>
        <div className="tl-heads">
          <div className="tl-ruler-head">Tracks</div>
          {tracks.map((t) => {
            const ch = s.channels.find((c) => c.id === t.id);
            return (
              <div key={t.id} className="tl-head" style={{ height: TRACK_H, borderLeftColor: t.color }}>
                <span className="tl-name">{t.name}</span>
                {ch && (
                  <div className="row">
                    <Toggle small kind="rec" on={ch.recArm} onClick={() => s.updateChannel(ch.id, { recArm: !ch.recArm })}>R</Toggle>
                    <Toggle small on={ch.inputMode === 'playback'} onClick={() => s.updateChannel(ch.id, { inputMode: ch.inputMode === 'live' ? 'playback' : 'live' })} title="Input: live source or playback of this track (virtual soundcheck)">
                      {ch.inputMode === 'live' ? 'LIVE' : 'PB'}
                    </Toggle>
                    <Toggle small kind="mute" on={ch.mute} onClick={() => s.dispatch({ type: 'channel.mute.toggle', args: { id: ch.id } })}>M</Toggle>
                    <button className="icon-btn" title="Import audio file onto this track" onClick={() => { setImportTrack(ch.id); fileRef.current?.click(); }}>⤓</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="tl-lanes" style={{ width: length * pps }}>
          <div
            className="tl-ruler"
            onPointerDown={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              seek((e.clientX - rect.left) / pps);
            }}
          >
            {Array.from({ length: Math.ceil(length / (pps < 8 ? 30 : pps < 30 ? 10 : 1)) }, (_, i) => {
              const step = pps < 8 ? 30 : pps < 30 ? 10 : 1;
              const t = i * step;
              return (
                <span key={i} className="tl-tick" style={{ left: t * pps }}>
                  {fmtTime(t).slice(0, 5)}
                </span>
              );
            })}
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
          {tracks.map((t) => (
            <div key={t.id} className="tl-lane" style={{ height: TRACK_H }} onPointerDown={() => setSel(null)}>
              {s.clips
                .filter((c) => c.trackId === t.id)
                .map((c) => (
                  <ClipView key={c.id} clip={c} pps={pps} selected={c.id === sel} onSelect={() => setSel(c.id)} />
                ))}
            </div>
          ))}
          {s.markers.map((m) => (
            <div key={m.id} className="tl-marker-line" style={{ left: m.time * pps }} />
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
      <p className="hint tl-foot">
        Arm tracks and hit Rec to multitrack the raw inputs (plus a PGM stereo record). Switch a channel to PB to feed it from its track for virtual soundcheck.
        Space = play/stop. Recordings are held in memory in this prototype — export WAVs to keep them.
      </p>
    </div>
  );
}
