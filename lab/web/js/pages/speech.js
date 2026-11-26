// Speech Lab: gain sharing between talkers' microphones plus a layered speech leveller.
import { api } from '../api.js';
import { h, clear, pageHead, panel, badge, empty, fmtTime, field, help, select, showError, confirmBox } from '../ui.js';
import { openImporter, editDetails, relinkFile } from '../importer.js';
import { TimeCanvas, drawPeaks } from '../charts.js';
import { progress } from './music.js';

const MIC_COLORS = ['#4ba8ff', '#e3a33a', '#46c46f', '#e5767a', '#a77bf0', '#12a594', '#8fa3b5', '#d4c35a'];

export async function render(root, [spId], app) {
  const { items } = await api.get('/api/library/speech');
  root.append(pageHead('Speech Lab', 'Multiple talkers’ microphones: the operator shares gain between them (only the mic being spoken into stays open) and levels each talker toward a target loudness.',
    h('button.primary', { onclick: () => openImporter('speech', { onDone: (it) => app.go(`speech/${it.id}`) }) }, '+ Import microphones')));
  if (!items.length) {
    root.append(panel('Speech recordings', empty('No speech recordings yet', 'Import one file per microphone, recorded at the same time (e.g. from Merge’s virtual soundcheck recordings or your recorder).',
      h('button.primary', { onclick: () => openImporter('speech', { onDone: (it) => app.go(`speech/${it.id}`) }) }, 'Import microphones'))));
    return;
  }
  const sp = items.find((x) => x.id === spId) || items[0];
  const list = h('div.panel.flat', h('div.ph', h('h2', 'Speech recordings')), h('div.pb', h('table', items.map((x) => h('tr.click' + (x.id === sp.id ? '.sel' : ''), { onclick: () => app.go(`speech/${x.id}`) },
    h('td', h('b', x.name), x.synthetic ? [' ', badge('synthetic', 'synthetic-data')] : null, x._missing?.length ? [' ', badge('files missing', 'error')] : null,
      h('div.faint.small', `${(x.mics || []).length} mics · ${fmtTime(x.mics?.[0]?.file.duration_s)}`)))))));
  const main = h('div');
  root.append(h('div', { style: { display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr)', gap: '14px' } }, list, main));
  form(main, sp, app);
}

function form(root, sp, app) {
  const cfg = { target_lufs: -20, last_hold: true, depth_db: -40, speech_level: { allow: true, min: -6, max: 6, rate_db_s: 1 }, mic_weights: {}, exclude_mics: [] };
  const dur = sp.mics?.[0]?.file.duration_s || 60;
  const name = h('input', { value: `${sp.name} — ${new Date().toLocaleDateString()}`, style: { width: '100%' } });
  const lanes = h('div.stack');
  (sp.mics || []).forEach((m, i) => {
    const tc = new TimeCanvas({ height: 34, duration: dur, selectable: false });
    const nm = m.name || m.file.name;
    cfg.mic_weights[nm] = m.weight_db || 0;
    const excluded = m.role !== 'speech';
    if (excluded) cfg.exclude_mics.push(nm);
    lanes.append(h('div', { style: { display: 'grid', gridTemplateColumns: '130px 1fr 210px', alignItems: 'center', gap: '8px' } },
      h('div.small', h('span.dot', { style: { background: MIC_COLORS[i % 8], marginRight: '6px' } }), nm, excluded ? h('div.faint', m.role) : null),
      tc.el,
      h('div.row.tight.small', excluded ? h('span.dim', 'excluded from gain sharing') : [
        h('label.row.tight', h('input', { type: 'checkbox', checked: true, onchange: (e) => { cfg.exclude_mics = e.target.checked ? cfg.exclude_mics.filter((x) => x !== nm) : [...cfg.exclude_mics, nm]; } }), 'use'),
        h('span', 'weight'), h('input', { type: 'number', step: 0.5, value: m.weight_db || 0, style: { width: '64px' }, onchange: (e) => { cfg.mic_weights[nm] = +e.target.value; } }), 'dB'])));
    api.get(`/api/peaks?${new URLSearchParams({ path: m.file.path, n: 1500, t: api.token() })}`).then((p) => { tc.drawFn = drawPeaks(p, MIC_COLORS[i % 8] + '99'); tc.render(); }).catch(() => {});
  });
  const lv = cfg.speech_level;
  const status = h('div');
  root.append(
    h('div.panel', h('div.ph', h('h2', sp.name), sp.synthetic ? badge('synthetic data', 'synthetic-data') : null, h('div.grow'),
      h('button.ghost', { onclick: () => editDetails('speech', sp, () => app.route()) }, 'Edit'),
      h('button.ghost', { onclick: async () => {
        if (!await confirmBox('Remove recording', 'Remove this speech recording from the library? Experiments are kept; original files are not touched.', 'Remove', true)) return;
        await api.post('/api/library/speech/remove', { id: sp.id, delete_copied: true }); await app.refresh(); app.go('speech');
      } }, 'Remove')),
      h('div.pb.stack',
        sp._missing?.length ? h('div.notice.warn', `Missing files: ${sp._missing.join(', ')}.`, (sp.mics || []).filter((m) => sp._missing.includes(m.file.name)).map((m) => h('button', { style: { marginLeft: '8px' }, onclick: () => relinkFile('speech', sp, m.file, () => app.route()) }, `Relink ${m.file.name}…`))) : null,
        h('h3', 'Microphones'), lanes,
        h('div.notice', h('b', 'Calibration. '), 'Gain sharing compares the microphones’ raw levels, so recordings should be made before channel gain or faders — Merge’s virtual soundcheck records exactly that (the pre-gain channel source). If your mics were recorded at very different input gains, use the weights to compensate; the result shows each talker’s measured speech level.'))),
    h('div.grid.g2',
      panel('Gain sharing', h('div.stack',
        field('Closed-mic depth', h('span', h('input', { type: 'number', step: 5, value: cfg.depth_db, max: 0, onchange: (e) => { cfg.depth_db = +e.target.value; } }), ' dB'),
          'The most a microphone nobody is speaking into is turned down. −40 dB is effectively off; −15 dB keeps some room sound.'),
        h('label.row', h('input', { type: 'checkbox', checked: cfg.last_hold, onchange: (e) => { cfg.last_hold = e.target.checked; } }),
          h('span', 'Last-mic hold '), help('During pauses, keep the last talker’s mic open instead of letting all mics drift to equal gain. Avoids room noise swelling between sentences.')))),
      panel('Speech leveller', h('div.stack',
        field('Target loudness', h('span', h('input', { type: 'number', step: 1, value: cfg.target_lufs, onchange: (e) => { cfg.target_lufs = +e.target.value; } }), ' LUFS'), 'The speech level each talker is brought toward (measured while they speak).'),
        h('div.form',
          field('Maximum boost', h('span', h('input', { type: 'number', step: 0.5, value: lv.max, onchange: (e) => { lv.max = +e.target.value; } }), ' dB')),
          field('Maximum cut', h('span', h('input', { type: 'number', step: 0.5, value: -lv.min, onchange: (e) => { lv.min = -Math.abs(+e.target.value); } }), ' dB')),
          field('Correction speed', h('span', h('input', { type: 'number', step: 0.1, value: lv.rate_db_s, onchange: (e) => { lv.rate_db_s = +e.target.value; } }), ' dB/s')))))),
    h('div.panel', h('div.pb.row', field('Experiment name', name), h('div', { style: { flex: 1 } }),
      h('button.primary.big', { disabled: sp._missing?.length, onclick: async () => {
        try { progress(status, await api.post('/api/experiments/speech', { name: name.value, inputs: { speech_id: sp.id }, config: cfg }), app); } catch (e) { showError(e); }
      } }, 'Analyse & render')), status));
}
