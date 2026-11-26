// Broadcast Compare: a stereo broadcast/livestream recording placed within a Program Sound Profile.
// Everything here is diagnostic evidence about the finished programme - never a source diagnosis
// and never a processing instruction.
import { api } from '../api.js';
import { h, clear, pageHead, panel, badge, statusBadge, empty, fmtTime, fmtDate, field, select, showError, toast, modal, md,
  pickAudio, confirmBox } from '../ui.js';
import { programView } from '../programviz.js';
import { Player } from '../player.js';
import { TimeCanvas, drawPeaks, drawSeries } from '../charts.js';
import { progress } from './music.js';

export async function render(root, [eid], app) {
  if (eid) return view(root, eid, app);
  const [{ items: recs }, { items: profiles }, { items: exps }] = await Promise.all([api.get('/api/library/recordings'), api.get('/api/profiles'), api.get('/api/experiments')]);
  const progProfiles = profiles.filter((p) => p.status === 'complete' && p.composition?.program_analysed);
  root.append(pageHead('Broadcast Compare', 'Compare a stereo recording of your service (broadcast, livestream or recorder) with a Program Sound Profile built from your references.',
    h('button.primary', { onclick: () => importRecordings(app) }, '+ Import recordings')),
    h('div.notice', h('b', 'Diagnostic only. '), 'A stereo recording shows the finished result, not which source caused it. Findings say where the recording sits relative to your references — confirm them by listening. They are never applied as processing.'));
  const status = h('div');
  let recId = recs[0]?.id, profId = progProfiles[0]?.id;
  const name = h('input', { value: `Broadcast check ${new Date().toLocaleDateString()}`, style: { width: '100%' } });
  root.append(h('div.grid.g2',
    panel('Recordings', recs.length ? h('table', h('tr', h('th', 'Recording'), h('th', 'Length'), h('th', 'Format'), h('th', '')),
      recs.map((r) => h('tr', h('td', h('b', r.name), r.synthetic ? [' ', badge('synthetic', 'synthetic-data')] : null, r._missing?.length ? [' ', badge('file missing', 'error')] : null,
        r.notes ? h('div.faint.small', r.notes) : null),
        h('td.num', fmtTime(r.mix?.duration_s)), h('td.small.dim', r.mix ? `${r.mix.sr / 1000} kHz · ${r.mix.channels === 2 ? 'stereo' : r.mix.channels + ' ch'}` : ''),
        h('td', h('button.ghost', { onclick: async () => {
          if (!await confirmBox('Remove recording', 'Remove this recording from the library? Comparisons made with it are kept; the file is not touched.', 'Remove', true)) return;
          await api.post('/api/library/recordings/remove', { id: r.id, delete_copied: true }); app.route();
        } }, 'Remove')))))
      : empty('No recordings yet', 'Import a stereo recording of a service mix.', h('button.primary', { onclick: () => importRecordings(app) }, 'Import recordings'))),
    panel('New comparison', h('div.stack',
      field('Recording', recs.length ? select(recs.map((r) => [r.id, r.name]), recId, (v) => { recId = v; }) : h('span.dim', 'Import a recording first')),
      field('Sound Profile', progProfiles.length ? select(progProfiles.map((p) => [p.id, `${p.name} (${p.composition.program_analysed} masters)`]), profId, (v) => { profId = v; })
        : h('span.dim', 'No profile with programme analysis yet — import masters and build a profile.')),
      field('Name', name),
      h('div.row', h('button.primary.big', { disabled: !recs.length || !progProfiles.length, onclick: async () => {
        try { progress(status, await api.post('/api/experiments/program', { name: name.value, inputs: { recording_id: recId, profile_id: profId }, config: {} }),
          { go: (p) => app.go(p.replace('listen/', 'broadcast/')) }); } catch (e) { showError(e); }
      } }, 'Compare')), status))));
  const past = exps.filter((e) => e.type === 'program');
  root.append(panel('Past comparisons', past.length ? h('table', h('tr', h('th', 'Comparison'), h('th', 'Recording'), h('th', 'Profile'), h('th', 'Findings'), h('th', 'Status'), h('th', 'Created')),
    past.map((e) => h('tr.click', { onclick: () => app.go(`broadcast/${e.id}`) }, h('td', e.name, e.synthetic ? [' ', badge('synthetic data', 'synthetic-data')] : null),
      h('td.small', e.inputs?.item_name), h('td.small', e.inputs?.profile_name), h('td.num', e.summary?.findings ?? '–'), h('td', statusBadge(e.status)), h('td.dim', fmtDate(e.created)))))
    : empty('No comparisons yet')));
}

async function importRecordings(app) {
  const paths = await pickAudio(true);
  if (!paths || !paths.length) return;
  try {
    const { files } = await api.post('/api/files/inspect', { paths });
    let n = 0;
    for (const f of files) {
      if (f.error) { toast(`${f.name}: ${f.error}`, true); continue; }
      await api.post('/api/library/recordings/add', { item: { name: f.name.replace(/\.[^.]+$/, ''), category: 'broadcast', notes: '' }, mix: f.path,
        copy: app.ws().settings.import_mode === 'copy' });
      n++;
    }
    toast(`${n} recording(s) added`);
    app.route();
  } catch (e) { showError(e); }
}

const SEV = { outside: 'warn', edge: 'info', within: 'ok', unknown: 'info' };

async function view(root, eid, app) {
  const meta = await api.get('/api/feedback');
  const VERD = meta.finding_verdicts;
  let data = await api.get(`/api/experiments/${eid}`);
  const E = data.experiment, A = data.analysis || {};
  root.append(pageHead(E.name, `Programme comparison · ${fmtDate(E.created)} · algorithms ${E.algorithm_version}`,
    E.synthetic ? badge('synthetic data', 'synthetic-data') : null, statusBadge(E.status), h('button.ghost', { onclick: () => app.go('broadcast') }, '‹ Broadcast Compare'),
    h('button', { onclick: async () => { try { await api.post(`/api/experiments/${eid}/rerun`, {}); toast('Rerun started'); app.go('broadcast'); } catch (e) { showError(e); } } }, 'Rerun'),
    h('button', { onclick: () => app.go(`export/exp/${eid}`) }, 'Export…')));
  if (E.status !== 'complete') return root.append(panel('Did not complete', h('pre.prompt', E.error || E.status)));
  const C = A.comparison, M = A.measurement, P = A.profile_program;
  root.append(h('div.notice', h('b', 'Diagnostic evidence. '), C.note, C.few_references ? ' Few references: ranges are the references’ full extent and indicative only.' : ''));

  // ---- player: the recording, with its short-term loudness
  const player = new Player();
  const timeEl = h('span.time', '0:00');
  const playBtn = h('button.primary', { onclick: () => player.toggle() }, '▶ Play');
  const wave = new TimeCanvas({ height: 70, duration: M.duration_s, onSeek: (t) => player.seek(t), selectable: false });
  const series = await api.get(`/api/experiments/${eid}/series`).catch(() => ({}));
  const pr = series.program;
  const lc = pr ? new TimeCanvas({ height: 90, duration: M.duration_s, onSeek: (t) => player.seek(t), selectable: false,
    draw: drawSeries({ time: pr.time_s, lines: [{ name: 'short-term', values: pr.shortterm_LUFS, color: '#4ba8ff' }] },
      { lo: Math.floor(Math.min(...pr.shortterm_LUFS.filter((v) => v != null)) / 6) * 6 || -40, hi: Math.ceil(Math.max(...pr.shortterm_LUFS.filter((v) => v != null)) / 3) * 3 || 0, unit: 'LUFS', zero: false }) }) : null;
  player.on((ev, _p, detail) => {
    if (ev === 'error' || ev === 'fallback') toast(detail, ev === 'error');
    const t = player.currentTime();
    timeEl.textContent = `${fmtTime(t, true)} / ${fmtTime(player.duration)}`;
    wave.setPlayhead(t); lc && lc.setPlayhead(t);
    if (ev !== 'time') playBtn.textContent = player.playing ? '❚❚ Pause' : '▶ Play';
  });
  const rec = (await api.get('/api/library/recordings')).items.find((r) => r.id === E.inputs.recording_id);
  if (rec?.mix) {
    api.get(api.peaksUrl({ path: rec.mix.path }, 2500)).then((p) => { wave.drawFn = drawPeaks(p); wave.render(); }).catch(() => {});
    player.load([{ key: 'rec', url: api.audioUrl({ path: rec.mix.path }) }]).catch(showError);
  }

  // ---- findings with engineer verdicts
  const findBox = h('div');
  const fbFor = (f) => data.feedback.findings?.find((x) => x.finding_id === f.id);
  function drawFindings() {
    const F = C.findings;
    clear(findBox, F.length ? F.map((f) => {
      const prev = fbFor(f);
      const st = { verdict: prev?.verdict || null, comment: prev?.comment || '' };
      const vb = h('div.row.tight');
      const drawV = () => clear(vb, Object.entries(VERD).map(([k, l]) => h('button.small' + (st.verdict === k ? '.on' : ''), { onclick: () => { st.verdict = k; drawV(); } }, l)));
      drawV();
      return h('div.decision', { style: { cursor: 'default' } },
        h('div.row', badge(f.domain, 'info'), badge(f.severity === 'outside' ? 'outside the references' : 'at the edge', SEV[f.severity]), h('b', f.label), h('div', { style: { flex: 1 } }),
          prev ? badge(VERD[prev.verdict], prev.verdict.startsWith('agree') ? 'ok' : prev.verdict === 'disagree' ? 'error' : 'info') : null),
        h('div', { style: { margin: '4px 0' } }, f.text),
        vb,
        h('div.row', { style: { marginTop: '6px' } }, h('input', { placeholder: 'Comment (what you hear, or why it is intended)', value: st.comment, style: { flex: 1 }, onchange: (e) => { st.comment = e.target.value; } }),
          h('button.primary', { onclick: async () => {
            if (!st.verdict) return toast('Choose a verdict', true);
            try {
              await api.post(`/api/feedback/${eid}/findings`, { id: prev?.id, finding_id: f.id, metric: f.metric, domain: f.domain, verdict: st.verdict, comment: st.comment,
                deviation: f.deviation, band_hz: f.band_hz || null });
              data = await api.get(`/api/experiments/${eid}`); drawFindings(); toast('Saved');
            } catch (e) { showError(e); }
          } }, prev ? 'Update' : 'Save')));
    }) : h('p.dim', 'The recording is within the references’ typical ranges on every measure.'));
  }
  drawFindings();

  // ---- notes
  const notesBox = h('div');
  function drawNotes() {
    const N = [...(data.feedback.notes || [])].sort((a, b) => a.time_s - b.time_s);
    clear(notesBox, h('div.row', h('button', { onclick: () => {
      const t = player.currentTime(); const ta = h('textarea', { placeholder: 'What do you hear here?' });
      modal({ title: `Note at ${fmtTime(t, true)}`, body: ta, actions: [{ label: 'Cancel' }, { label: 'Save note', primary: true, run: async () => {
        if (!ta.value.trim()) return false;
        await api.post(`/api/feedback/${eid}/notes`, { time_s: +t.toFixed(2), version: 'recording', text: ta.value.trim() });
        data = await api.get(`/api/experiments/${eid}`); drawNotes();
      } }] });
    } }, '+ Note at the playhead')),
    N.length ? h('table', N.map((n) => h('tr', h('td', h('a', { href: '#', onclick: (e) => { e.preventDefault(); player.seek(Math.max(0, n.time_s - 2)); } }, fmtTime(n.time_s, true))), h('td', n.text),
      h('td', h('button.ghost', { onclick: async () => { await api.post(`/api/feedback/${eid}/notes/delete`, { id: n.id }); data = await api.get(`/api/experiments/${eid}`); drawNotes(); } }, '✕'))))) : h('p.dim', 'No notes yet.'));
  }
  drawNotes();

  const selected = { id: '__rec', title: 'This recording', scalars: M.scalars, spectrum_shape: M.spectrum.shape_dB, variation_p10: M.spectrum.variation_p10_dB,
    variation_p90: M.spectrum.variation_p90_dB, stereo_bands: M.stereo_bands.values, curves: M.curves };
  const metricsTable = h('table', h('tr', h('th', 'Measure'), h('th', 'Recording'), h('th', 'References p10 … p90'), h('th', 'Position'), h('th', '')),
    C.metrics.map((r) => h('tr', h('td', r.label), h('td.num', r.value == null ? '–' : `${r.value} ${r.unit}`), h('td.num.dim', r.stats ? `${r.stats.p10} … ${r.stats.p90} ${r.unit}` : '–'),
      h('td', badge(r.status === 'within' ? 'within' : r.status === 'edge' ? 'edge' : r.status === 'outside' ? 'outside' : '–', SEV[r.status])),
      h('td.small.faint', r.expected_difference || ''))));
  root.append(
    h('div.grid.g-side',
      h('div.stack',
        h('div.transport', playBtn, h('button', { onclick: () => player.stop() }, '■'), timeEl, h('div', { style: { flex: 1 } }), h('span.small.dim', 'Recording as supplied (not level-matched)')),
        wave.el, lc ? [h('b.small', 'Short-term loudness'), lc.el] : null,
        panel(`Findings (${C.findings.length})`, findBox)),
      h('div.stack', panel('Notes', notesBox), panel('Context', h('div.kv', h('span', 'Profile'), h('span', A.profile), h('span', 'References'), h('span', C.n_references),
        h('span', 'Recording'), h('span', `${fmtTime(M.duration_s)} (${fmtTime(M.programme_s)} of programme)`), ...(A.warnings || []).flatMap((w) => [h('span', 'Warning'), h('span', w)]))))),
    programView({ profile: P, refs: P.references || [], selected, selectedLabel: 'This recording', findings: C.findings }),
    panel('All measures', metricsTable),
    data.report ? panel('Report', md(data.report)) : null);
  return () => { player.close(); };
}
