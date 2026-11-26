// Planned modules: shown so the roadmap is visible, never presented as working features.
import { h, pageHead, badge } from '../ui.js';

const INFO = {
  plugin: ['Plugin Intelligence Lab', 'Learning how specific plugins respond (EQ, compressors, de-essers) so recommendations can name real plugin parameters.',
    'Requires native plugin characterisation, gesture echo suppression and parameter ramps (see the plugin architecture document). Recommendations in the Music Lab already use plugin-agnostic actions so this can be added later.'],
  hybrid: ['Hybrid Lab', 'Speech over music: pastor talking over a pad, announcements over a band.', 'Designed only. Needs the speech and music specialists to share one operator with ducking rules.'],
  ambience: ['Ambience Lab', 'Audience and room microphones: how much ambience to blend for broadcast.', 'Designed only.'],
  program: ['Program Lab', 'Programme bus headroom and loudness steering.', 'Headroom proposals exist as experimental recommendations; no render or listening workflow yet.'],
  teach: ['Teach Mode', 'Recording what you do on the console during a service so it can be compared with what the operator would have done.',
    'Not built. Feedback in this Lab is stored as research data for review; it does not train the operator automatically.'],
  soundcheck: ['Virtual Soundcheck import', 'Importing multitrack recordings made with Merge’s own virtual soundcheck.',
    'Merge now records pre-gain channel sources to ~/Music/Merge Recordings. Group-bus taps and an offline render (native plan N2, N6) are still open. Until then, export group stems from your DAW.'],
};

export function render(root, [id]) {
  const [title, what, status] = INFO[id] || ['Planned module', '', ''];
  root.append(pageHead(title, null, badge('Planned', 'planned')),
    h('div.panel', h('div.pb.stack', h('p', what), h('h3', 'Status'), h('p.dim', status),
      h('p.faint.small', 'This module is listed so the roadmap is visible. Nothing on this page performs any processing.'))));
}
