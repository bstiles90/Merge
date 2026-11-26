// Listening Room: sample-aligned A/B listening, the operator's decision timeline, engineer
// feedback (decisions, notes, missed interventions, overall), blind trials, measurements.
import { api } from '../api.js';
import { h, clear, pageHead, panel, badge, statusBadge, empty, fmtTime, fmtDb, fmtDate, groupName, groupColor, field, help, select, seg, modal,
  showError, toast, confirmBox, promptBox, md, GROUPS } from '../ui.js';
import { Player } from '../player.js';
import { TimeCanvas, drawPeaks, drawSeries, drawLanes, legend } from '../charts.js';

const MIC_COLORS = ['#4ba8ff', '#e3a33a', '#46c46f', '#e5767a', '#a77bf0', '#12a594', '#8fa3b5', '#d4c35a'];
const NAMES = {
  music: { before: 'Original', after: 'Adjusted', after_experimental_eq: 'Adjusted + exp. EQ' },
  speech: { before: 'Original (all mics open)', after_automix: 'Gain sharing', after: 'Gain sharing + leveller' },
};
const ASPECTS = {
  music: ['overall', 'vocal_balance', 'instrument_balance', 'tonal_clarity', 'low_end', 'vocal_intelligibility', 'dynamics', 'transients', 'musical_expression', 'naturalness', 'ambience'],
  speech: ['overall', 'speech_clarity', 'vocal_intelligibility', 'naturalness', 'dynamics', 'ambience', 'broadcast_quality'],
};
const ASPECT_LABEL = { overall: 'Overall', vocal_balance: 'Vocal balance', instrument_balance: 'Instrument balance', tonal_clarity: 'Tonal clarity', low_end: 'Low-end control',
  vocal_intelligibility: 'Intelligibility', dynamics: 'Dynamics', transients: 'Transient impact', musical_expression: 'Musical expression', naturalness: 'Naturalness',
  ambience: 'Ambience', speech_clarity: 'Speech clarity', broadcast_quality: 'Broadcast quality' };
const RATINGS = [['improved', 'Improved'], ['no_difference', 'No difference'], ['degraded', 'Degraded'], ['na', 'N/A']];
const PREF_LABEL = { fader: 'Channel fader', group_fader: 'Group fader', eq: 'EQ', compression: 'Compression', dynamic_eq: 'Dynamic EQ', deesser: 'De-esser',
  transient: 'Transient shaping', mic_activity: 'Mic on/off (gain sharing)', speech_level: 'Speech level', none: 'No action', other: 'Other' };
let META = null;

export async function render(root, [eid], app) {
  if (!META) META = await api.get('/api/feedback').then((r) => ({ verdicts: r.verdicts, categories: r.categories, kinds: r.preferred_kinds }));
  if (!eid) return picker(root, app);
  if (eid.startsWith('pg-')) return app.go(`broadcast/${eid}`);
  let data = await api.get(`/api/experiments/${eid}`);
  const E = data.experiment, A = data.analysis || {};
  const type = E.type;
  root.append(pageHead(E.name, [`${type === 'music' ? 'Music' : 'Speech'} experiment · ${fmtDate(E.created)} · algorithms ${E.algorithm_version || '?'}`,
    E.inputs.profile_name ? ` · profile “${E.inputs.profile_name}”` : '', E.inputs.item_name ? ` · ${E.inputs.item_name}` : ''].join(''),
    E.synthetic ? badge('synthetic data', 'synthetic-data') : null, statusBadge(E.status),
    h('button.ghost', { onclick: () => app.go('listen') }, '‹ All'),
    h('button', { onclick: () => rerun(E, app) }, 'Rerun'),
    h('button', { onclick: () => app.go(`history/compare/${E.id}`) }, 'Compare…'),
    h('button', { onclick: () => app.go(`export/exp/${E.id}`) }, 'Export…')));
  if (E.status !== 'complete') {
    root.append(panel('This experiment did not complete', h('div.stack', h('div.finding.error', h('span.i', '✕'), h('pre.prompt', { style: { margin: 0, flex: 1 } }, E.error || E.status)),
      h('div.row', h('button.primary', { onclick: () => rerun(E, app) }, 'Run it again')))));
    return;
  }
  if (!A.render) { root.append(panel('No listening files', empty('This experiment has no rendered audio', E.renders_deleted ? 'The renders were deleted to save space. Rerun to recreate them.' : ''))); return; }

  // ------------------------------------------------------------------ state
  const R = A.render;
  const names = NAMES[type];
  const versionKeys = Object.keys(R.files).sort((a, b) => Object.keys(names).indexOf(a) - Object.keys(names).indexOf(b));
  const groupsAvail = R.groups ? Object.keys(R.groups) : [];
  const player = new Player();
  player.crossfade = (app.ws().settings.crossfade_ms || 8) / 1000;
  let trial = null;         // active blind trial
  let selDecision = null;   // index into decisions
  let selRegion = null;     // [a, b]
  const events = A.events || [];
  const decisions = (data.decisions || []).map((d, i) => {
    const ev = d.kind === 'groupGainOffset' && d.time_s ? events.find((e) => Math.abs(e.t - d.time_s[0]) < 0.01 && e.group === d.target.group) : null;
    return { ...d, index: i, from: ev ? ev.from : d.baseline };
  });
  const timed = decisions.filter((d) => d.time_s && d.maturity === 'validated');
  const untimed = decisions.filter((d) => !timed.includes(d));
  const fb = () => data.feedback;
  const fbFor = (d) => fb().decisions.find((x) => x.decision_id === d.id || (x.decision_id == null && x.decision_index === d.index));
  async function reload() {
    data = await api.get(`/api/experiments/${eid}`);
    drawDecisions(); drawTabs(); refreshMarkers();
  }

  // ------------------------------------------------------------------ transport
  const timeEl = h('span.time', '0:00.0 / 0:00');
  const vbtns = h('div.row.tight');
  const playBtn = h('button.primary.big', { onclick: () => player.toggle(), title: 'Play / pause (space)' }, '▶ Play');
  const loopBtn = h('button', { onclick: () => toggleLoop(), title: 'Loop the selected region (L)' }, '⟲ Loop');
  const vol = h('input', { type: 'range', min: -40, max: 6, step: 1, value: 0, oninput: (e) => { player.setVolume(+e.target.value); volOut.textContent = `${e.target.value} dB`; } });
  const volOut = h('span.small.num.dim', '0 dB');
  const lmTip = `All versions were rendered to ${R.target_LUFS} LUFS integrated so level differences cannot bias the comparison. Gain applied: ` +
    Object.entries(R.gains_dB || {}).map(([k, v]) => `${names[k] || k} ${fmtDb(v)}`).join(', ') + (R.common_peak_trim_dB ? `; common peak trim ${fmtDb(R.common_peak_trim_dB)}` : '') + '.';
  const lmPill = h('span.lm', { title: lmTip }, `✓ Loudness-matched · ${R.target_LUFS} LUFS`);
  const groupBox = h('div.row.tight');
  const loadState = h('span.small.dim');
  function drawVersionButtons() {
    const keys = trial ? ['A', 'B'] : versionKeys;
    clear(vbtns, keys.map((k, i) => h('button.vbtn' + (player.active === k ? '.on' : ''), { onclick: () => player.setActive(k), title: `Switch (${i + 1})` },
      h('span.k', i + 1), trial ? `Version ${k}` : names[k] || k)));
  }
  function drawGroups() {
    if (!groupsAvail.length || trial) return clear(groupBox);
    const activeHasGroups = ['before', 'after'].includes(player.active);
    clear(groupBox,
      h('button' + (player.groupMode ? '.on' : ''), { disabled: !activeHasGroups, title: activeHasGroups ? 'Hear individual groups (solo / mute)' : 'Group audition is available for Original and Adjusted',
        onclick: () => player.setGroupMode(!player.groupMode) }, 'Group audition'),
      player.groupMode ? groupsAvail.map((g) => h('span.row.tight', { style: { marginLeft: '6px' } },
        h('span.dot', { style: { background: groupColor(g) } }), h('span.small', groupName(g)),
        h('button.small' + (player.solo.has(g) ? '.on' : ''), { style: { padding: '1px 6px' }, onclick: () => player.toggleSolo(g) }, 'S'),
        h('button.small' + (player.mute.has(g) ? '.on' : ''), { style: { padding: '1px 6px' }, onclick: () => player.toggleMute(g) }, 'M'))) : null);
  }
  player.on((ev, _p, detail) => {
    if (ev === 'time' || ev === 'seek' || ev === 'stop' || ev === 'pause' || ev === 'play' || ev === 'loaded') {
      const t = player.currentTime();
      timeEl.textContent = `${fmtTime(t, true)} / ${fmtTime(player.duration)}`;
      for (const c of canvases) c.setPlayhead(t);
      if (ev !== 'time') playBtn.textContent = player.playing ? '❚❚ Pause' : '▶ Play';
    }
    if (ev === 'active' || ev === 'loaded') { drawVersionButtons(); drawGroups(); }
    if (ev === 'groups') drawGroups();
    if (ev === 'loading') loadState.textContent = 'Loading audio…';
    if (ev === 'loaded') loadState.textContent = player.long ? 'Long recording: loaded in sections around the playhead' : '';
    if (ev === 'loop') loopBtn.classList.toggle('on', !!player.loop);
    if (ev === 'error') { toast(detail, true); loadState.textContent = detail; }
    if (ev === 'fallback') { loadState.textContent = detail; toast(detail); drawGroups(); }
  });
  async function loadNormal() {
    const vers = versionKeys.map((k) => ({ key: k, url: api.audioUrl({ exp: eid, file: `audio/${R.files[k]}` }) }));
    const groups = {};
    for (const g of groupsAvail) groups[g] = Object.fromEntries(Object.entries(R.groups[g]).map(([v, p]) => [v, api.audioUrl({ exp: eid, file: `audio/${p}` })]));
    player.active = versionKeys.includes('after') ? 'before' : versionKeys[0];
    try { await player.load(vers, groups); } catch (e) { showError(e); }
  }
  function toggleLoop() {
    if (player.loop) player.setLoop(null, null);
    else if (selRegion) player.setLoop(selRegion[0], selRegion[1]);
    else toast('Drag across the waveform to choose a region to loop.');
  }

  // ------------------------------------------------------------------ waveform + timeline
  const canvases = [];
  const onSeek = (t) => player.seek(t);
  const onSelect = (sel) => { selRegion = sel; for (const c of canvases) { c.sel = sel; c.render(); } regionBar(); if (player.loop) player.setLoop(sel[0], sel[1]); };
  const wave = new TimeCanvas({ height: 86, duration: A.duration_s || 60, onSeek, onSelect });
  canvases.push(wave);
  api.get(api.peaksUrl({ exp: eid, file: `audio/${R.files.before}` }, 3000)).then((p) => { wave.setDuration(p.duration_s); wave.drawFn = drawPeaks(p); wave.render(); for (const c of canvases) c.setDuration(p.duration_s); refreshMarkers(); }).catch(() => {});
  const regionInfo = h('div.row.small');
  function regionBar() {
    clear(regionInfo, selRegion ? [h('span.dim', `Selected ${fmtTime(selRegion[0], true)} – ${fmtTime(selRegion[1], true)}`),
      h('button.small', { onclick: () => player.setLoop(selRegion[0], selRegion[1]) }, 'Loop it'),
      h('button.small', { onclick: () => missedDialog(selRegion) }, 'Mark as missed intervention…'),
      h('button.small', { onclick: () => noteDialog(selRegion[0]) }, 'Note here…'),
      h('button.small.ghost', { onclick: () => { selRegion = null; for (const c of canvases) { c.sel = null; c.render(); } player.setLoop(null, null); regionBar(); } }, 'Clear')]
      : h('span.faint', 'Click to jump · drag to select a region (loop it, add a note, or mark a missed intervention)'));
  }
  const timeline = h('div.stack');
  const series = await api.get(`/api/experiments/${eid}/series`).catch(() => ({}));
  if (type === 'music' && series.offsets) {
    const groups = Object.keys(series.offsets).filter((k) => k !== 'time_s');
    const lines = groups.map((g) => ({ name: groupName(g), key: g, values: series.offsets[g], color: groupColor(g) }));
    const mx = Math.max(2, ...lines.flatMap((l) => l.values.map(Math.abs)));
    const lim = Math.ceil(mx + 0.5);
    const tc = new TimeCanvas({ height: 130, duration: A.duration_s, onSeek, onSelect, draw: drawSeries({ time: series.offsets.time_s, lines }, { lo: -lim, hi: lim, step: true }) });
    canvases.push(tc);
    timeline.append(h('div.row', h('b.small', ['Fader offsets proposed by the operator ', help('The validated decisions: how far each group fader is moved from your mix, over time. These are what the Adjusted version applies.')]),
      h('div', { style: { flex: 1 } }), legend(lines, (it, hidden) => { it.hidden = hidden; tc.render(); })), tc.el);
    if (series.activity) {
      const lanes = groups.map((g) => ({ name: groupName(g), values: series.activity[g] || [], color: groupColor(g) }));
      const ac = new TimeCanvas({ height: 14 * groups.length + 4, duration: A.duration_s, onSeek, onSelect, draw: drawLanes(series.activity.time_s, lanes) });
      canvases.push(ac);
      timeline.append(h('b.small', ['Detected activity ', help('Where each group was judged to be playing. Balance is only measured between groups that play together; wrong activity is a common cause of wrong decisions.')]), ac.el);
    }
  }
  if (type === 'speech' && series.speech) {
    const S = series.speech, mics = A.mic_names || [];
    const share = mics.map((m, i) => ({ name: m, values: S[`share_db:${m}`] || [], color: MIC_COLORS[i % 8] }));
    const lev = mics.map((m, i) => ({ name: m, values: S[`leveller_db:${m}`] || [], color: MIC_COLORS[i % 8], dash: [4, 3] }));
    const sc = new TimeCanvas({ height: 120, duration: A.duration_s, onSeek, onSelect, draw: drawSeries({ time: S.time_s, lines: share }, { lo: -42, hi: 2 }) });
    const lc = new TimeCanvas({ height: 90, duration: A.duration_s, onSeek, onSelect, draw: drawSeries({ time: S.time_s, lines: lev }, { lo: -8, hi: 8 }) });
    canvases.push(sc, lc);
    timeline.append(h('div.row', h('b.small', ['Gain sharing per microphone ', help('0 dB = this mic is fully open (someone is speaking into it); lower = turned down while someone else talks.')]), h('div', { style: { flex: 1 } }),
      legend(share, (it, hid) => { it.hidden = hid; lev.find((x) => x.name === it.name).hidden = hid; sc.render(); lc.render(); })), sc.el,
      h('b.small', ['Speech leveller ', help('Slow level correction that brings each talker toward the target loudness while they speak.')]), lc.el);
  }
  function refreshMarkers() {
    const F = data.feedback;
    const markers = [];
    timed.forEach((d) => {
      const f = fbFor(d);
      markers.push({ t: d.time_s[0], color: groupColor(d.target.group), width: d.index === selDecision ? 3 : 1.5, top: 0,
        label: `${groupName(d.target.group)} ${fmtDb(d.from)} → ${fmtDb(d.proposed)}${f ? ' · ' + META.verdicts[f.verdict] : ''}`, onclick: () => selectDecision(d.index, true) });
    });
    F.notes.forEach((n) => markers.push({ t: n.time_s, color: '#e1e6ea', flag: true, alpha: 0.8, label: `Note: ${n.text.slice(0, 60)}`, onclick: () => player.seek(Math.max(0, n.time_s - 2)) }));
    const regions = [];
    (Array.isArray(A.baseline_regions_s) ? A.baseline_regions_s : []).forEach(([a, b]) => regions.push({ a, b, color: 'rgba(63,154,86,0.10)', label: 'baseline' }));
    (A.injections || []).forEach((j) => regions.push({ a: j.start, b: j.end, color: 'rgba(229,72,77,0.10)', label: `${groupName(j.group)} ${fmtDb(j.db, 1)} injected` }));
    F.missed.forEach((m) => regions.push({ a: m.start_s, b: m.end_s, color: 'rgba(227,163,58,0.14)', label: `missed: ${groupName(m.target)}` }));
    wave.markers = markers; wave.regions = regions; wave.render();
    for (const c of canvases.slice(1)) { c.markers = markers.filter((m) => !m.flag).map((m) => ({ ...m, alpha: 0.35, width: 1 })); c.render(); }
  }

  // ------------------------------------------------------------------ decisions + feedback
  const decBox = h('div');
  function selectDecision(i, seek) {
    selDecision = i;
    const d = decisions[i];
    if (seek && d.time_s) player.seek(Math.max(0, d.time_s[0] - 4));
    drawDecisions(); refreshMarkers();
  }
  function decisionText(d) {
    if (d.kind === 'groupGainOffset') return `${groupName(d.target.group)} ${fmtDb(d.from)} → ${fmtDb(d.proposed)}`;
    if (d.kind === 'speechAutomix') return `${d.target.mic}: gain sharing${d.proposed ? ' weight ' + fmtDb(d.proposed) : ''}`;
    if (d.kind === 'speechLevel') return `${d.target.mic}: leveller ${fmtDb(d.proposed)}`;
    const t = d.target.group || d.target.mic || '';
    return `${({ eqBandGain: 'EQ', compressionIntensity: 'Compression', programSteering: 'Programme headroom', softGate: 'Soft gate' })[d.kind] || d.kind}${t ? ' · ' + groupName(t) : ''}: ${fmtDb(d.proposed, 1, d.unit === 'dB' ? 'dB' : d.unit)}`;
  }
  function decisionCard(d) {
    const f = fbFor(d), sel = d.index === selDecision;
    return h('div.decision' + (sel ? '.sel' : ''), { onclick: () => !sel && selectDecision(d.index, true) },
      h('div.row', d.time_s ? h('span.mono.dim', fmtTime(d.time_s[0], true)) : null, h('b', decisionText(d)), h('div', { style: { flex: 1 } }),
        d.maturity !== 'validated' ? badge(d.status === 'recommendation-only' ? 'recommendation' : d.maturity, 'experimental') : null,
        f ? badge(META.verdicts[f.verdict], f.verdict.startsWith('correct') ? 'ok' : f.verdict === 'unable' ? 'info' : 'warn') : null),
      h('div.meta', d.reason?.text || ''),
      sel ? feedbackForm(d, f) : null);
  }
  function feedbackForm(d, f) {
    const st = { verdict: f?.verdict || null, kind: f?.preferred?.kind || (d.kind === 'groupGainOffset' ? 'group_fader' : 'none'), value: f?.preferred?.value ?? '',
      category: f && !f.category_auto ? f.category : '', comment: f?.comment || '' };
    const vb = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', margin: '8px 0' } });
    const drawV = () => clear(vb, Object.entries(META.verdicts).map(([k, l]) => h('button.small' + (st.verdict === k ? '.on' : ''), { style: { justifyContent: 'flex-start', fontSize: '11.5px' },
      onclick: (e) => { e.stopPropagation(); st.verdict = k; drawV(); } }, l)));
    drawV();
    const stop = (e) => e.stopPropagation();
    return h('div', { onclick: stop },
      h('div.row.small', h('button.small', { onclick: () => player.seek(Math.max(0, (d.time_s?.[0] || 0) - 4)) }, '⟲ From 4 s before'),
        h('button.small', { onclick: () => { player.setActive('before'); player.play(Math.max(0, (d.time_s?.[0] || 0) - 4)); } }, '▶ Original'),
        h('button.small', { onclick: () => { player.setActive('after'); player.play(Math.max(0, (d.time_s?.[0] || 0) - 4)); } }, '▶ Adjusted')),
      d.expected?.length ? h('div.faint.small', { style: { marginTop: '6px' } }, 'Expected effect: ' + d.expected.map((x) => `${x.metric} ${fmtDb(x.delta, 1, 'LU')}`).join(', ')) : null,
      vb,
      h('div.row', field('What would you have done?', select(META.kinds.map((k) => [k, PREF_LABEL[k] || k]), st.kind, (v) => { st.kind = v; })),
        field('Amount (dB)', h('input', { type: 'number', step: 0.5, value: st.value, style: { width: '70px' }, onchange: (e) => { st.value = e.target.value; } }))),
      field('Problem category (optional)', select([['', 'Automatic from verdict'], ...Object.entries(META.categories)], st.category, (v) => { st.category = v; })),
      field('Comment', h('textarea', { value: st.comment, placeholder: 'Why? What did you hear?', onchange: (e) => { st.comment = e.target.value; } })),
      h('div.row', { style: { marginTop: '6px' } },
        h('button.primary', { onclick: async () => {
          if (!st.verdict) return toast('Choose a verdict first', true);
          try {
            await api.post(`/api/feedback/${eid}/decisions`, { id: f?.id, decision_index: d.index, decision_id: d.id, decision_kind: d.kind, time_s: d.time_s?.[0] ?? null,
              target: d.target.group || d.target.mic, proposed: d.proposed, verdict: st.verdict, category: st.category || undefined,
              preferred: st.kind ? { kind: st.kind, value: st.value === '' ? null : +st.value } : null, comment: st.comment, listened_version: player.active });
            toast('Feedback saved'); await reload();
          } catch (e) { showError(e); }
        } }, f ? 'Update' : 'Save feedback'),
        f ? h('button.ghost', { onclick: async () => { await api.post(`/api/feedback/${eid}/decisions/delete`, { id: f.id }); reload(); } }, 'Remove') : null,
        h('div', { style: { flex: 1 } }),
        h('button.ghost', { onclick: () => { selDecision = null; drawDecisions(); refreshMarkers(); } }, 'Close')));
  }
  function drawDecisions() {
    const done = decisions.filter((d) => fbFor(d)).length;
    clear(decBox,
      h('div.row', h('h2', 'Decisions'), h('div', { style: { flex: 1 } }), h('span.small.dim', `${done} of ${decisions.length} reviewed`)),
      h('p.faint.small', type === 'music' ? 'Validated fader decisions are applied in the Adjusted version. Click one to hear it and say whether it was right.' : 'Per-microphone decisions applied in the rendered versions.'),
      timed.length ? timed.map(decisionCard) : null,
      type === 'music' && !timed.length ? h('p.dim', 'The operator made no fader changes on this mix.') : null,
      untimed.length ? [h('h3', type === 'music' ? 'Recommendations (not applied)' : 'Microphone decisions'), untimed.map(decisionCard)] : null);
  }

  // ------------------------------------------------------------------ dialogs
  function noteDialog(t0) {
    const t = t0 ?? player.currentTime();
    const ta = h('textarea', { placeholder: 'What do you hear at this moment?' });
    const cat = select([['', 'No category'], ...Object.entries(META.categories)], '', () => {});
    modal({ title: `Note at ${fmtTime(t, true)} (${trial ? 'blind version ' + player.active : names[player.active] || player.active})`, body: h('div.stack', ta, field('Category', cat)),
      actions: [{ label: 'Cancel' }, { label: 'Save note', primary: true, run: async () => {
        if (!ta.value.trim()) return false;
        await api.post(`/api/feedback/${eid}/notes`, { time_s: +t.toFixed(2), version: trial ? null : player.active, blind_letter: trial ? player.active : null, trial_id: trial?.id,
          text: ta.value.trim(), category: cat.value || undefined });
        toast('Note saved'); reload();
      } }] });
    setTimeout(() => ta.focus(), 30);
  }
  function missedDialog([a, b]) {
    const targets = type === 'music' ? (Object.keys(A.groups || {}).length ? Object.keys(A.groups) : GROUPS) : (A.mic_names || []);
    const st = { target: targets[0], kind: type === 'music' ? 'group_fader' : 'speech_level', value: '', issue: '', category: '' };
    modal({ title: `Missed intervention ${fmtTime(a, true)} – ${fmtTime(b, true)}`, body: h('div.stack',
      h('p.dim', 'Something the operator should have done here but did not.'),
      h('div.form', field(type === 'music' ? 'Group' : 'Microphone', select(targets.map((g) => [g, groupName(g)]), st.target, (v) => { st.target = v; })),
        field('What should have happened?', select(META.kinds.map((k) => [k, PREF_LABEL[k] || k]), st.kind, (v) => { st.kind = v; })),
        field('Amount (dB)', h('input', { type: 'number', step: 0.5, onchange: (e) => { st.value = e.target.value; } })),
        field('Category', select([['', 'Automatic'], ...Object.entries(META.categories)], '', (v) => { st.category = v; }))),
      field('Describe the problem', h('textarea', { placeholder: 'e.g. keys too quiet in the bridge', onchange: (e) => { st.issue = e.target.value; } }))),
    actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, run: async () => {
      await api.post(`/api/feedback/${eid}/missed`, { start_s: +a.toFixed(2), end_s: +b.toFixed(2), target: st.target, issue: st.issue,
        preferred: { kind: st.kind, value: st.value === '' ? null : +st.value }, category: st.category || 'insufficient_gain' });
      toast('Saved'); reload();
    } }] });
  }

  // ------------------------------------------------------------------ tabs
  const tabBar = h('div.seg'); const tabBody = h('div', { style: { marginTop: '10px' } });
  let tab = 'notes';
  const TABS = { notes: 'Notes', missed: 'Missed interventions', overall: 'Overall evaluation', blind: 'Blind tests', measure: 'Measurements', report: 'Report', details: 'Details' };
  function drawTabs() {
    clear(tabBar, Object.entries(TABS).map(([k, l]) => h('button' + (k === tab ? '.on' : ''), { onclick: () => { tab = k; drawTabs(); } }, l,
      k === 'notes' && data.feedback.notes.length ? ` (${data.feedback.notes.length})` : '', k === 'missed' && data.feedback.missed.length ? ` (${data.feedback.missed.length})` : '',
      k === 'blind' && data.listening.trials.length ? ` (${data.listening.tally.answered})` : '')));
    clear(tabBody, TABV[tab]());
  }
  const TABV = {
    notes() {
      const N = [...data.feedback.notes].sort((a, b) => a.time_s - b.time_s);
      return h('div.stack', h('div.row', h('button', { onclick: () => noteDialog() }, '+ Note at the playhead'), h('span.faint.small', 'Shortcut: N')),
        N.length ? h('table', h('tr', h('th', 'Time'), h('th', 'Version'), h('th', 'Note'), h('th', 'Category'), h('th', '')),
          N.map((n) => h('tr', h('td', h('a', { href: '#', onclick: (e) => { e.preventDefault(); player.seek(Math.max(0, n.time_s - 2)); } }, fmtTime(n.time_s, true))),
            h('td.small', n.version ? names[n.version] || n.version : n.blind_letter ? `blind ${n.blind_letter}` : '–'), h('td', n.text),
            h('td.small.dim', n.category ? META.categories[n.category] : ''),
            h('td', h('button.ghost', { onclick: async () => { await api.post(`/api/feedback/${eid}/notes/delete`, { id: n.id }); reload(); } }, '✕')))))
          : h('p.dim', 'No notes yet. Notes are pinned to the moment in the song where you add them.'));
    },
    missed() {
      const M = data.feedback.missed;
      return h('div.stack', h('p.dim.small', 'Select a region on the waveform, then “Mark as missed intervention”.'),
        M.length ? h('table', h('tr', h('th', 'Region'), h('th', 'Target'), h('th', 'Problem'), h('th', 'Should have'), h('th', '')),
          M.map((m) => h('tr', h('td', h('a', { href: '#', onclick: (e) => { e.preventDefault(); player.seek(m.start_s); } }, `${fmtTime(m.start_s)}–${fmtTime(m.end_s)}`)),
            h('td', groupName(m.target)), h('td', m.issue), h('td.small', m.preferred ? `${PREF_LABEL[m.preferred.kind] || m.preferred.kind}${m.preferred.value != null ? ' ' + fmtDb(m.preferred.value) : ''}` : ''),
            h('td', h('button.ghost', { onclick: async () => { await api.post(`/api/feedback/${eid}/missed/delete`, { id: m.id }); reload(); } }, '✕'))))) : h('p.dim', 'None recorded.'));
    },
    overall() {
      const targets = versionKeys.filter((k) => k !== 'before');
      let ver = targets.includes('after') ? 'after' : targets[0];
      const box = h('div');
      const drawO = () => {
        const prev = data.feedback.overall.find((o) => o.version === ver && !o.blind);
        const ratings = { ...(prev?.ratings || {}) };
        let comment = prev?.comment || '';
        clear(box, h('div.stack',
          h('p.dim.small', `Compare “${names[ver]}” with “${names.before}”. This is a non-blind evaluation (you know which is which); blind results are kept separately.`),
          h('table', ASPECTS[type].map((a) => h('tr', h('td', ASPECT_LABEL[a]), h('td', seg(RATINGS, ratings[a] || null, (v) => { ratings[a] = v; }))))),
          field('Comment', h('textarea', { value: comment, onchange: (e) => { comment = e.target.value; } })),
          h('div.row', h('button.primary', { onclick: async () => {
            const clean = Object.fromEntries(Object.entries(ratings).filter(([, v]) => v));
            if (!Object.keys(clean).length) return toast('Rate at least one aspect', true);
            try { await api.post(`/api/feedback/${eid}/overall`, { id: prev?.id, version: ver, compared_to: 'before', ratings: clean, comment, blind: false }); toast('Evaluation saved'); reload(); } catch (e) { showError(e); }
          } }, prev ? 'Update evaluation' : 'Save evaluation'), prev ? h('span.small.dim', `saved ${fmtDate(prev.modified || prev.created)}`) : null)));
      };
      drawO();
      return h('div.stack', targets.length > 1 ? field('Version being judged', select(targets.map((k) => [k, names[k]]), ver, (v) => { ver = v; drawO(); })) : null, box);
    },
    blind() {
      const L = data.listening;
      const pairs = versionKeys.filter((k) => k !== 'before').map((k) => ['before|' + k, `${names.before} vs ${names[k]}`]);
      if (versionKeys.includes('after_experimental_eq')) pairs.push(['after|after_experimental_eq', `${names.after} vs ${names.after_experimental_eq}`]);
      let pair = pairs[0][0];
      const active = trial ? h('div.panel', h('div.ph', h('h2', 'Blind trial in progress'), h('div.grow'), badge('versions hidden', 'warn')), h('div.pb.stack',
        h('p', 'Listen to A and B (keys 1 and 2), switching as often as you like. Which do you prefer?', trial.segment_s ? ` Segment ${fmtTime(trial.segment_s[0])}–${fmtTime(trial.segment_s[1])} (looping).` : ''),
        blindAnswer())) : null;
      return h('div.stack', active || h('div.row', field('Compare', select(pairs, pair, (v) => { pair = v; })),
        h('button.primary', { onclick: () => startTrial(pair.split('|')) }, 'Start a blind trial'),
        h('span.small.dim', selRegion ? `uses the selected region ${fmtTime(selRegion[0])}–${fmtTime(selRegion[1])}` : 'select a region first to test just one passage')),
        h('p.faint.small', L.tally.note),
        L.tally.answered ? h('div.row', Object.entries(L.tally.preferences).map(([k, n]) => badge(`${names[k] || (k === 'no_preference' ? 'No preference' : k === 'unable' ? 'Unable to tell' : k)}: ${n}`, 'info'))) : null,
        L.trials.length ? h('table', h('tr', h('th', 'When'), h('th', 'Segment'), h('th', 'Answer'), h('th', 'Preferred'), h('th', 'Confidence'), h('th', 'Comment')),
          L.trials.slice().reverse().map((t) => h('tr', h('td.small', fmtDate(t.created)), h('td.small', t.segment_s ? `${fmtTime(t.segment_s[0])}–${fmtTime(t.segment_s[1])}` : 'whole'),
            h('td', t.answer ? t.answer.choice.replace('_', ' ') : h('span.dim', 'not answered')),
            h('td', t.assignment ? (t.preferred_version ? names[t.preferred_version] || t.preferred_version : '–') : h('span.faint', 'hidden')),
            h('td.small', t.answer?.confidence || ''), h('td.small', t.answer?.comment || '')))) : null);
    },
    measure() { return measurements(type, A); },
    report() { return panel('Report', data.report ? md(data.report, (src) => `/api/file?${new URLSearchParams({ exp: eid, file: src, t: api.token() })}`) : empty('No report')); },
    details() { return details(E, data, app, reload); },
  };
  function blindAnswer() {
    let conf = null, comment = '';
    return h('div.stack',
      h('div.row', [['A', 'I prefer A'], ['B', 'I prefer B'], ['no_preference', 'No preference'], ['unable', 'Can’t tell them apart']].map(([c, l]) =>
        h('button' + (c.length === 1 ? '.primary' : ''), { onclick: async () => {
          try {
            const r = await api.post(`/api/listening/${eid}/trial/${trial.id}/answer`, { choice: c, comment, confidence: conf });
            const t = r.trial;
            modal({ title: 'Revealed', body: h('div.stack', h('p', h('b', 'A'), ` was ${names[t.assignment.A]}; `, h('b', 'B'), ` was ${names[t.assignment.B]}.`),
              h('p', t.preferred_version ? `You preferred ${names[t.preferred_version]}.` : 'No preference recorded.'),
              h('p.faint.small', 'Stored as a blind result, separately from your non-blind evaluations.')), actions: [{ label: 'Back to normal listening', primary: true }] });
            await endTrial();
          } catch (e) { showError(e); }
        } }, l))),
      h('div.row', field('Confidence', seg([['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], null, (v) => { conf = v; })),
        field('Comment (optional)', h('input', { style: { width: '320px' }, onchange: (e) => { comment = e.target.value; } }))),
      h('div.row', h('button.ghost', { onclick: async () => { await api.post(`/api/listening/${eid}/trial/${trial.id}/reveal`); await endTrial(); } }, 'Give up and reveal')));
  }
  async function startTrial(versions) {
    try {
      const seg = selRegion ? [+selRegion[0].toFixed(2), +selRegion[1].toFixed(2)] : null;
      trial = (await api.post(`/api/listening/${eid}/trial`, { versions, segment: seg })).trial;
      player.groupMode = false;
      player.active = 'A';
      await player.load(['A', 'B'].map((k) => ({ key: k, url: api.audioUrl({ exp: eid, trial: trial.id, letter: k }) })));
      if (seg) player.setLoop(seg[0], seg[1]);
      decBox.parentElement.parentElement.style.display = 'none'; timeline.style.display = 'none';
      drawTabs(); drawVersionButtons(); drawGroups();
      player.play(seg ? seg[0] : 0);
    } catch (e) { showError(e); trial = null; }
  }
  async function endTrial() {
    trial = null; player.stop();
    decBox.parentElement.parentElement.style.display = ''; timeline.style.display = '';
    await loadNormal(); await reload(); drawVersionButtons(); drawGroups();
  }

  // ------------------------------------------------------------------ layout
  const refBtn = type === 'music' && E.inputs.profile_id ? h('button', { onclick: () => referencePlayer(E, app, player, R.target_LUFS) }, '♫ Reference…') : null;
  root.append(h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 380px', gap: '14px', alignItems: 'start' } },
    h('div.stack',
      h('div.transport', playBtn, h('button', { onclick: () => player.stop(), title: 'Stop' }, '■'), timeEl, vbtns, h('div', { style: { flex: 1 } }), lmPill),
      h('div.row', loopBtn, groupBox, h('div', { style: { flex: 1 } }), refBtn, h('span.small.dim', 'Volume'), vol, volOut),
      wave.el, regionInfo, timeline,
      h('div.row.small.faint', 'Keys: space play/pause · 1–3 switch version · ←/→ 5 s · L loop · N note. Output device: choose it in macOS System Settings → Sound.', h('span', loadState)),
      h('div', { style: { marginTop: '6px' } }, tabBar, tabBody)),
    h('div.panel', { style: { position: 'sticky', top: '0', maxHeight: 'calc(100vh - 120px)', overflowY: 'auto' } }, h('div.pb', decBox))));
  regionBar(); drawDecisions(); drawTabs(); refreshMarkers();
  await loadNormal();

  const key = (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || document.querySelector('.modal-bg')) return;
    const keys = trial ? ['A', 'B'] : versionKeys;
    if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
    else if (/^Digit[1-9]$/.test(e.code)) { const k = keys[+e.code.slice(5) - 1]; if (k) player.setActive(k); }
    else if (e.key === 'ArrowLeft') player.seek(player.currentTime() - 5);
    else if (e.key === 'ArrowRight') player.seek(player.currentTime() + 5);
    else if (e.key === 'l' || e.key === 'L') toggleLoop();
    else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); noteDialog(); }
    else if (e.key === 'Home') player.seek(0);
  };
  document.addEventListener('keydown', key);
  return () => { document.removeEventListener('keydown', key); player.close(); };
}

async function rerun(E, app) {
  try { const r = await api.post(`/api/experiments/${E.id}/rerun`, {}); toast('Rerun started — it appears in Experiment History. The original is kept.'); app.go('history'); return r; } catch (e) { showError(e); }
}

async function referencePlayer(E, app, main, target) {
  const prof = await api.get(`/api/profiles/${E.inputs.profile_id}`).catch(() => null);
  const { items } = await api.get('/api/library/references');
  const refs = items.filter((r) => (prof?.meta.reference_ids || []).includes(r.id) && r.master);
  if (!refs.length) return toast('The references of this profile have no master file to play.', true);
  const p = new Player();
  const info = h('div.small.dim');
  const timeEl = h('span.mono', '');
  p.on((ev) => { if (['time', 'seek', 'stop', 'play', 'pause'].includes(ev)) timeEl.textContent = `${fmtTime(p.currentTime())} / ${fmtTime(p.duration)}`; });
  const load = async (rid) => {
    const r = refs.find((x) => x.id === rid);
    p.stop(); clear(info, 'Measuring loudness…');
    let trim = 0, note = 'not loudness-matched';
    try { const L = await api.post('/api/files/loudness', { path: r.master.path }); if (L.integrated_LUFS != null) { trim = target - L.integrated_LUFS; note = `level-matched to ${target} LUFS (${fmtDb(trim)})`; } } catch (e) {}
    await p.load([{ key: 'ref', url: api.audioUrl({ path: r.master.path }), trimDb: trim }]);
    clear(info, `Mastered reference, ${note}. It is a different song, so it cannot be switched sample-aligned with your mix.`);
  };
  main.pause();
  modal({ title: 'Reference playback', body: h('div.stack', select(refs.map((r) => [r.id, r.title]), refs[0].id, load),
    h('div.row', h('button.primary', { onclick: () => p.toggle() }, '▶ / ❚❚'), h('button', { onclick: () => p.stop() }, '■'), timeEl), info),
    onClose: () => p.close() });
  load(refs[0].id);
}

function measurements(type, A) {
  if (type === 'speech') return h('div.grid.g2',
    panel('Microphones', h('table', h('tr', h('th', 'Mic'), h('th', 'Holds the floor'), h('th', 'Speech level'), h('th', 'Leveller'), h('th', 'Weight')),
      (A.mics || []).map((m) => h('tr', h('td', m.name), h('td.num', `${m.floor_s} s`), h('td.num', `${m.speech_LUFS} LUFS`), h('td.num', fmtDb(m.leveller_db)), h('td.num', fmtDb(m.weight_db)))))),
    panel('Calibration & noise', h('div.kv', h('span', 'Talker level spread'), h('span', `${A.calibration?.spread_dB} dB`), h('span', ''), h('span.small.dim', A.calibration?.note),
      h('span', 'Handovers'), h('span', A.handovers), h('span', 'Idle noise before'), h('span', `${A.idle_noise_before_db} dB`), h('span', 'Idle noise after'), h('span', `${A.idle_noise_after_db} dB`),
      h('span', 'Target loudness'), h('span', `${A.target_LUFS} LUFS`))),
    (A.warnings || []).length ? panel('Warnings', A.warnings.map((w) => h('div.finding.warn', h('span.i', '!'), h('span', w)))) : null);
  const I = A.injection_score;
  return h('div.stack',
    I ? panel('Known disturbances', [h('table', h('tr', h('th', 'Disturbance'), h('th', 'Ideal correction'), h('th', 'Achieved'), h('th', 'Corrected'), h('th', 'Largest side effect')),
      I.injections.map((j) => h('tr', h('td', `${groupName(j.group)} ${fmtDb(j.db)} (${fmtTime(j.start)}–${fmtTime(j.end)})`), h('td.num', fmtDb(j.ideal_dB, 2)), h('td.num', fmtDb(j.achieved_dB, 2)),
        h('td.num', j.corrected_fraction == null ? '–' : `${Math.round(j.corrected_fraction * 100)} %`, j.saturated ? [' ', badge('hit limit', 'warn')] : null),
        h('td.num', j.max_other_mean_abs_dB == null ? '–' : `${j.max_other_mean_abs_dB.toFixed(2)} dB`)))),
      h('p.faint.small', `Scored against an undisturbed run of the same mix. Movement outside the disturbances: ${I.rms_response_outside_disturbances_dB} dB RMS.`)]) : null,
    h('div.grid.g2',
      panel('Operator behaviour', h('div.kv', h('span', 'Total fader movement'), h('span', `${A.offset_summary.total_movement_dB} dB`), h('span', 'Direction reversals'), h('span', A.offset_summary.direction_reversals),
        h('span', 'Largest offset'), h('span', fmtDb(A.offset_summary.max_abs_offset_dB)), h('span', 'Mean offset'),
        h('span', Object.entries(A.offset_summary.mean_offset_dB).map(([g, v]) => `${groupName(g)} ${fmtDb(v, 2)}`).join(' · ')),
        h('span', 'Reference influence β'), h('span', A.controller.beta), h('span', 'Evidence window'), h('span', `${A.controller.evidence_s} s`))),
      panel('Programme', h('table', h('tr', h('th', ''), h('th', 'Original'), h('th', 'Adjusted'), h('th', 'References')),
        [['integrated_LUFS', 'Integrated', 'LUFS'], ['LRA_LU', 'Loudness range', 'LU'], ['truePeak_dBTP', 'True peak', 'dBTP']].map(([k, l, u]) =>
          h('tr', h('td', l), h('td.num', `${A.program_before[k]} ${u}`), h('td.num', `${A.program_after[k]} ${u}`), h('td.num.dim', `${A.program_before.reference_program[k]} ${u}`)))),
        h('p.faint.small', A.program_before.note))),
    panel('Pairwise balance', h('table', h('tr', h('th', 'Pair'), h('th', 'Your mix'), h('th', 'Baseline'), h('th', 'Reference'), h('th', 'Target (β blend)'), h('th', 'Deviation'), h('th', 'Played together')),
      A.pairs.map((p) => h('tr', h('td', p.pair.split('-').map(groupName).join(' − ')), h('td.num', fmtDb(p.live_median_LU, 1, 'LU')), h('td.num', fmtDb(p.baseline_LU, 1, 'LU')),
        h('td.num', fmtDb(p.reference_LU, 1, 'LU')), h('td.num', fmtDb(p.target_LU, 1, 'LU')),
        h('td.num', { style: { color: p.outside ? 'var(--warn)' : '' } }, fmtDb(p.deviation_LU, 1, 'LU')), h('td.num', `${Math.round(p.coactive_s)} s`))))),
    (A.warnings || []).length ? panel('Warnings', A.warnings.map((w) => h('div.finding.warn', h('span.i', '!'), h('span', w)))) : null);
}

function details(E, data, app, reload) {
  return h('div.grid.g2',
    panel('Experiment', h('div.kv',
      h('span', 'ID'), h('span.mono', E.id), h('span', 'Created'), h('span', fmtDate(E.created)), h('span', 'Finished'), h('span', fmtDate(E.finished)),
      h('span', 'App version'), h('span', E.app_version), h('span', 'Algorithm version'), h('span', E.algorithm_version), h('span', 'Code revision'), h('span.mono', E.git_commit || '–'),
      h('span', 'Derived from'), E.parent_id ? h('a', { href: `#/listen/${E.parent_id}` }, E.parent_id) : h('span', '–'),
      h('span', 'Input'), h('span', E.inputs.item_name || '–'), h('span', 'Profile'), h('span', E.inputs.profile_name || '–'),
      h('span', 'Settings'), h('pre.prompt', { style: { margin: 0 } }, JSON.stringify(E.config, null, 1)),
      E.injections?.length ? [h('span', 'Disturbances'), h('span', E.injections.map((j) => `${groupName(j.group)} ${fmtDb(j.db)} ${fmtTime(j.start)}–${fmtTime(j.end)}`).join('; '))] : null)),
    h('div.stack',
      panel('Inputs (fingerprints)', h('table', h('tr', h('th', 'File'), h('th', 'Role'), h('th', 'Fingerprint')),
        E.input_fingerprints.map((f) => h('tr', h('td.small', f.name), h('td.small', f.group ? `${f.role} · ${groupName(f.group)}` : f.role), h('td.mono.small', f.fingerprint))))),
      panel('Manage', h('div.row',
        h('button', { onclick: async () => { const n = await promptBox('Rename experiment', 'Name', E.name); if (n) { await api.post(`/api/experiments/${E.id}/rename`, { name: n }); app.route(); } } }, 'Rename'),
        h('button', { onclick: async () => { await api.post(`/api/experiments/${E.id}/${E.archived ? 'unarchive' : 'archive'}`); toast(E.archived ? 'Restored' : 'Archived'); app.route(); } }, E.archived ? 'Unarchive' : 'Archive'),
        h('button', { onclick: async () => {
          if (!await confirmBox('Delete rendered audio', 'Delete this experiment’s rendered listening files to save space? Measurements, decisions and feedback are kept; rerun to recreate the audio.', 'Delete renders', true)) return;
          await api.post(`/api/experiments/${E.id}/delete-renders`); app.route();
        } }, 'Delete renders'),
        h('button.danger', { onclick: async () => {
          if (!await confirmBox('Delete experiment', 'Permanently delete this experiment, its measurements and all feedback on it? Library files are not affected.', 'Delete', true)) return;
          await api.post(`/api/experiments/${E.id}/delete`, { confirm: true }); app.go('history');
        } }, 'Delete experiment')))));
}

async function picker(root, app) {
  const { items } = await api.get('/api/experiments');
  const ok = items.filter((e) => e.status === 'complete' && ['music', 'speech'].includes(e.type) && !e.archived);
  root.append(pageHead('Listening Room', 'Choose an experiment to listen to. Original and adjusted versions play in sync; switching never restarts playback.'));
  if (!ok.length) return root.append(panel('Experiments', empty('Nothing to listen to yet', 'Analyse a mix in the Music Lab or a recording in the Speech Lab.',
    h('button.primary', { onclick: () => app.go('music') }, 'Music Lab'), h('button', { onclick: () => app.go('speech') }, 'Speech Lab'))));
  root.append(h('div.panel.flat', h('div.pb', h('table', h('tr', h('th', 'Experiment'), h('th', 'Type'), h('th', 'Input'), h('th', 'Created'), h('th', '')),
    ok.map((e) => h('tr.click', { onclick: () => app.go(`listen/${e.id}`) }, h('td', h('b', e.name), e.synthetic ? [' ', badge('synthetic data', 'synthetic-data')] : null),
      h('td', e.type), h('td.small', e.inputs?.item_name || ''), h('td.dim', fmtDate(e.created)), h('td', h('button.primary', 'Listen'))))))));
}
