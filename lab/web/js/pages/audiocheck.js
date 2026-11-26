// Audio self-check: can this window decode the Lab's WAV files and play them through Web Audio and
// through standard <audio> elements? Results are shown and recorded in the diagnostics export.
import { api, clientLog } from '../api.js';
import { h, clear, pageHead, panel, badge } from '../ui.js';
import { wavHeader, wavFrames, sharedContext, ensureRunning } from '../wav.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runAudioCheck(onStep = () => {}) {
  const url = api.audioUrl({}).replace('/api/audio', '/api/test-tone');
  const R = { userAgent: navigator.userAgent, webaudio_available: !!(window.AudioContext || window.webkitAudioContext) };
  try {
    const info = await wavHeader(url);
    const buf = await wavFrames(null, info, 0, info.frames);
    R.decode = { ok: true, frames: buf.length, sampleRate: buf.sampleRate, peak: Math.max(...buf.getChannelData(0).slice(0, 48000).map(Math.abs)).toFixed(3) };
    onStep(R);
    try {
      const ctx = sharedContext();
      R.webaudio_state_before = ctx.state;
      const running = await ensureRunning(2000);
      R.webaudio_state = ctx.state;
      const t0 = ctx.currentTime;
      if (running) {
        const s = ctx.createBufferSource(); s.buffer = buf; s.connect(ctx.destination); s.start();
        await wait(800);
      } else await wait(300);
      R.webaudio = { ok: running && ctx.currentTime - t0 > 0.3, clock_advanced_s: +(ctx.currentTime - t0).toFixed(3), sampleRate: ctx.sampleRate };
    } catch (e) { R.webaudio = { ok: false, error: e.message }; }
    onStep(R);
  } catch (e) { R.decode = { ok: false, error: e.message }; }
  try {
    const el = new Audio(url);
    el.volume = 0.6;
    await el.play();
    await wait(700);
    R.media_element = { ok: el.currentTime > 0.3, currentTime: +el.currentTime.toFixed(3) };
    el.pause();
  } catch (e) { R.media_element = { ok: false, error: e.message || String(e) }; }
  onStep(R);
  clientLog('audiocheck', 'audio self-check', { results: R });
  return R;
}

export async function render(root, [mode], app) {
  const out = h('div');
  const row = (label, r) => h('tr', h('td', label), h('td', r ? badge(r.ok ? 'works' : 'failed', r.ok ? 'ok' : 'error') : badge('…', 'info')),
    h('td.small.dim.mono', r ? JSON.stringify(r) : ''));
  const draw = (R) => clear(out, h('table',
    row('Read and decode a Lab WAV file', R.decode), row('Web Audio (sample-aligned A/B player)', R.webaudio), row('Standard audio element (fallback player)', R.media_element)),
    R.media_element ? h('p', R.webaudio?.ok ? 'You should have heard two short tones twice. The Listening Room will work normally.'
      : R.media_element.ok ? 'Web Audio did not start in this window. The Listening Room will use the standard audio fallback (in time, but not sample-aligned). Please export diagnostics (Settings) so this can be fixed.'
        : 'Audio could not be played in this window. Check the macOS output device and volume (System Settings → Sound), then run the test again. If it still fails, export diagnostics from Settings.') : null);
  const start = async () => { draw({}); await runAudioCheck(draw); };
  root.append(pageHead('Audio self-check', 'Plays two short test tones through each playback method the Listening Room uses.',
    h('button.primary', { onclick: start }, 'Run the test'), app.ws() ? h('button.ghost', { onclick: () => app.go('settings') }, '‹ Settings') : null),
    panel('Results', out));
  draw({});
  if (mode === 'auto') start();   // CI (--audio-check): run without a click
}
