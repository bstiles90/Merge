// A small modal player for a single file (reference masters, stems).
import { api } from './api.js';
import { h, modal } from './ui.js';

export function quickPlayer(title, params) {
  const a = h('audio', { controls: true, src: api.audioUrl(params), style: { width: '100%' }, autoplay: true });
  modal({ title, body: h('div.stack', a, h('p.faint.small', 'Plays the file as it is (not loudness-matched).')), onClose: () => a.pause() });
}
