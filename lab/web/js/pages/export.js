// Research Export: a reviewable package (measurements, decisions, feedback) for an outside reviewer
// such as Claude. Privacy-first defaults; nothing is uploaded anywhere.
import { api, desktop } from '../api.js';
import { h, clear, pageHead, panel, badge, empty, fmtBytes, fmtDate, select, showError, toast, md } from '../ui.js';

export async function render(root, [mode, arg], app) {
  const [{ items: exps }, { items: profiles }] = await Promise.all([api.get('/api/experiments'), api.get('/api/profiles')]);
  const versions = [...new Set(exps.map((e) => e.algorithm_version).filter(Boolean))];
  const st = {
    scope: mode === 'exp' ? 'experiments' : mode === 'profile' ? 'profile_id' : 'experiments',
    experiments: new Set(mode === 'exp' ? arg.split(',') : exps.filter((e) => e.status === 'complete').slice(0, 1).map((e) => e.id)),
    profile_id: mode === 'profile' ? arg : profiles[0]?.id, algorithm_version: versions[0], comparison: [exps[1]?.id, exps[0]?.id],
    opts: { include_comments: true, anonymize: false, include_rendered_audio: false, include_original_audio: false },
  };
  const scopeBody = h('div'), prevBody = h('div'), result = h('div');
  root.append(pageHead('Research Export', 'Build a ZIP with the evidence from your experiments — measurements, operator decisions, your feedback and blind results — plus a summary and a review prompt. You decide where it goes; the Lab never uploads it.'),
    h('div.grid.g-side', h('div', panel('What to include', scopeBody), panel('Preview', prevBody), result),
      h('div', panel('Privacy', h('div.stack', opt('include_comments', 'Include my written comments and notes'),
        opt('anonymize', 'Replace song, mix and recording names with neutral labels'),
        h('div.sep'),
        opt('include_rendered_audio', 'Include rendered listening files', 'May contain copyrighted or church audio. Only share with people allowed to hear it.'),
        opt('include_original_audio', 'Include original source audio', 'Your multitracks or commercial stems. Usually not needed: measurements are enough for review.'),
        h('p.faint.small', 'Always excluded: absolute file paths, your home folder name, credentials and tokens. The blind-trial answer keys of unanswered trials stay hidden.'))))));
  function opt(k, label, warn) {
    return h('label.row', { style: { alignItems: 'flex-start' } }, h('input', { type: 'checkbox', checked: st.opts[k], onchange: (e) => { st.opts[k] = e.target.checked; preview(); } }),
      h('span', label, warn ? h('div.small', { style: { color: 'var(--warn)' } }, warn) : null));
  }
  function scope() {
    if (st.scope === 'experiments') return { experiments: [...st.experiments] };
    if (st.scope === 'session') return { session: true };
    if (st.scope === 'profile_id') return { profile_id: st.profile_id };
    if (st.scope === 'algorithm_version') return { algorithm_version: st.algorithm_version };
    if (st.scope === 'failed') return { failed: true };
    if (st.scope === 'comparison') return { comparison: st.comparison };
    return {};
  }
  function drawScope() {
    const radio = (v, label, extra) => h('div', h('label.row', h('input', { type: 'radio', name: 'scope', checked: st.scope === v, onchange: () => { st.scope = v; drawScope(); preview(); } }), h('b', label)),
      st.scope === v && extra ? h('div', { style: { margin: '6px 0 10px 24px' } }, extra) : null);
    const expOpts = exps.map((e) => [e.id, `${e.name} · ${e.type} · ${fmtDate(e.created)}`]);
    clear(scopeBody, h('div.stack',
      radio('experiments', 'Selected experiments', h('div.scroll-y', { style: { maxHeight: '220px' } }, exps.length ? exps.map((e) => h('label.row', h('input', { type: 'checkbox', checked: st.experiments.has(e.id),
        onchange: (ev) => { ev.target.checked ? st.experiments.add(e.id) : st.experiments.delete(e.id); preview(); } }), e.name, h('span.faint.small', `${e.type} · ${e.status} · ${fmtDate(e.created)}`))) : h('p.dim', 'No experiments.'))),
      radio('session', 'Everything in this workspace'),
      radio('profile_id', 'One Sound Profile and every experiment that used it', profiles.length ? select(profiles.map((p) => [p.id, p.name]), st.profile_id, (v) => { st.profile_id = v; preview(); }) : h('span.dim', 'No profiles')),
      radio('algorithm_version', 'All experiments from one algorithm version', versions.length ? select(versions.map((v) => [v, v]), st.algorithm_version, (v) => { st.algorithm_version = v; preview(); }) : null),
      radio('failed', 'Failed, cancelled and interrupted experiments (for troubleshooting)'),
      radio('comparison', 'A comparison of two experiments', h('div.row', select(expOpts, st.comparison[0], (v) => { st.comparison[0] = v; preview(); }), 'vs', select(expOpts, st.comparison[1], (v) => { st.comparison[1] = v; preview(); })))));
  }
  let last = null;
  async function preview() {
    try {
      const p = await api.post('/api/export/preview', { scope: scope(), options: st.opts });
      last = p;
      const cats = {};
      p.files.forEach((f) => { cats[f.category] = (cats[f.category] || 0) + 1; });
      clear(prevBody, h('div.stack',
        h('div.row', badge(`${p.selection.experiments.length} experiment(s)`, 'info'), badge(`${p.selection.profiles.length} profile(s)`, 'info'),
          p.contains_audio ? badge('contains audio', 'warn') : badge('no audio', 'ok'), p.contains_comments ? badge('comments included', 'info') : badge('comments excluded', 'ok'),
          h('span.small.dim', `≈ ${fmtBytes(p.total_bytes)} before compression`)),
        h('details', h('summary', { style: { cursor: 'pointer', color: 'var(--text-secondary)' } }, `${p.files.length} files`),
          h('table', p.files.map((f) => h('tr', h('td.mono.small', f.path), h('td.small.dim', f.category), h('td.num.small', f.size ? fmtBytes(f.size) : ''))))),
        h('div.row', h('button.primary.big', { disabled: !p.selection.experiments.length && !p.selection.profiles.length, onclick: build }, 'Create research package'),
          desktop.available() ? h('button', { onclick: () => build(true) }, 'Save as…') : null,
          h('button', { onclick: copyPrompt }, 'Copy review prompt'))));
    } catch (e) { clear(prevBody, h('div.finding.error', h('span.i', '✕'), h('span', e.message))); }
  }
  async function copyPrompt() {
    const r = await api.post('/api/export/prompt', { scope: scope() });
    copy(r.prompt, 'Review prompt copied');
  }
  async function copy(text, msg) {
    try { await navigator.clipboard.writeText(text); toast(msg); return; } catch (e) {}
    const r = await api.post('/api/os/copy', { text }); toast(r.ok ? msg : 'Could not copy automatically — select the text and copy it.', !r.ok);
  }
  async function build(saveAs) {
    try {
      let dest = null;
      if (saveAs === true) { dest = await desktop.saveFile('merge-lab-research.zip'); if (!dest) return; }
      const r = await api.post('/api/export/build', { scope: scope(), options: st.opts, dest });
      clear(result, panel('Package created', h('div.stack',
        h('p', h('b', r.name + '.zip'), h('div.faint.small', r.path)),
        h('div.row', h('button', { onclick: () => api.post('/api/os/reveal', { path: r.path }) }, 'Show in Finder'),
          h('button', { onclick: () => copy(r.summary, 'Summary copied') }, 'Copy summary'), h('button', { onclick: () => copy(r.prompt, 'Prompt copied') }, 'Copy review prompt')),
        h('p.dim.small', 'To get a review: start a conversation with Claude, attach this ZIP, and paste the review prompt. Nothing was sent anywhere by the Lab.'),
        h('details', h('summary', { style: { cursor: 'pointer' } }, 'SUMMARY.md'), md(r.summary)),
        h('details', h('summary', { style: { cursor: 'pointer' } }, 'PROMPT.md'), h('pre.prompt', r.prompt)))));
      result.scrollIntoView({ behavior: 'smooth' });
    } catch (e) { showError(e); }
  }
  drawScope();
  if (!exps.length && !profiles.length) clear(prevBody, empty('Nothing to export yet'));
  else preview();
}
