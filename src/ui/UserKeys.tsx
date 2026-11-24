import { useEffect, useState } from 'react';
import { ACTIONS, describeAction, keyIsOn, type ArgSpec } from '../core/actions';
import { useConsole } from '../core/store';
import type { ActionCall, ConsoleState, UserKey } from '../core/types';
import { cancelLearnHotkey, learnHotkey } from '../control/hotkeys';
import { midiStatus, onMidiChange, startLearn } from '../control/midi';
import { ColorPicker } from './Detail';

export function UserKeyGrid({ onEdit }: { onEdit?: (id: string) => void }) {
  const s = useConsole();
  return (
    <div className="ukeys">
      {s.userKeys.map((k, i) => {
        const lit = keyIsOn(s, k.actions) ?? !!s.keyStates[k.id];
        return (
          <button
            key={k.id}
            className={'ukey' + (lit ? ' lit' : '') + (s.keyStates[k.id] ? ' held' : '')}
            style={{ ['--kc' as string]: k.color }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
              s.pressKey(k.id);
            }}
            onPointerUp={() => s.releaseKey(k.id)}
            onPointerCancel={() => s.releaseKey(k.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onEdit?.(k.id);
            }}
            title={`${k.actions.map((a) => describeAction(s, a)).join('\n')}\n${k.hotkey ? `Hotkey: ${k.hotkey}` : ''}\nRight-click to edit`}
          >
            <span className="ukey-num">{i + 1}</span>
            <span className="ukey-label">{k.label}</span>
            {k.mode === 'momentary' && <span className="ukey-mode">MOM</span>}
            {k.hotkey && <span className="ukey-hk">{k.hotkey}</span>}
          </button>
        );
      })}
    </div>
  );
}

function ArgInput({ spec, value, onChange, s }: { spec: ArgSpec; value: any; onChange: (v: any) => void; s: ConsoleState }) {
  const opts = (list: { id: string; name: string }[]) => (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">— {spec.label} —</option>
      {list.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
  switch (spec.kind) {
    case 'channel':
      return opts(s.channels);
    case 'bus':
      return opts(s.buses);
    case 'dca':
      return opts(s.dcas);
    case 'muteGroup':
      return opts(s.muteGroups);
    case 'scene':
      return opts(s.scenes);
    case 'layer':
      return opts(s.layers);
    case 'moment':
      return opts(s.automation.moments);
    case 'boolean':
      return (
        <label className="row">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {spec.label}
        </label>
      );
    case 'number':
      return (
        <label className="row">
          {spec.label}
          <input type="number" value={value ?? 0} onChange={(e) => onChange(Number(e.target.value))} style={{ width: 70 }} />
        </label>
      );
  }
}

export function KeyEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const s = useConsole();
  const key = s.userKeys.find((k) => k.id === id);
  const [learning, setLearning] = useState<'hotkey' | 'midi' | null>(null);
  const [, force] = useState(0);
  useEffect(() => onMidiChange(() => {
    force((x) => x + 1);
    if (!midiStatus().learning) setLearning((l) => (l === 'midi' ? null : l));
  }), []);
  useEffect(() => () => cancelLearnHotkey(), []);
  if (!key) return null;
  const up = (p: Partial<UserKey>) => s.updateKey(id, p);
  const setAction = (i: number, a: ActionCall) => up({ actions: key.actions.map((x, j) => (j === i ? a : x)) });
  const categories = [...new Set([...ACTIONS.values()].map((a) => a.category))];
  const midi = midiStatus();

  return (
    <div className="key-editor">
      <div className="row between">
        <h3>Edit user key</h3>
        <button onClick={onClose}>Done</button>
      </div>
      <div className="form">
        <label>
          Label
          <textarea rows={2} value={key.label} onChange={(e) => up({ label: e.target.value })} />
        </label>
        <label>
          Colour
          <ColorPicker value={key.color} onChange={(color) => up({ color })} />
        </label>
        <label>
          Mode
          <select value={key.mode} onChange={(e) => up({ mode: e.target.value as UserKey['mode'] })}>
            <option value="latch">Latch — press fires</option>
            <option value="momentary">Momentary — press fires, release reverts (cough / talkback)</option>
          </select>
        </label>
        <div className="form-group">
          <div className="section-title">Actions (run in order — a macro)</div>
          {key.actions.map((a, i) => {
            const def = ACTIONS.get(a.type);
            return (
              <div key={i} className="action-row">
                <select
                  value={a.type}
                  onChange={(e) => {
                    const d = ACTIONS.get(e.target.value)!;
                    setAction(i, { type: d.type, args: Object.fromEntries(d.args.map((x) => [x.name, x.default ?? ''])) as ActionCall['args'] });
                  }}
                >
                  {categories.map((cat) => (
                    <optgroup key={cat} label={cat}>
                      {[...ACTIONS.values()]
                        .filter((d) => d.category === cat)
                        .map((d) => (
                          <option key={d.type} value={d.type}>
                            {d.label}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
                {def?.args.map((spec) => (
                  <ArgInput key={spec.name} spec={spec} s={s} value={a.args[spec.name]} onChange={(v) => setAction(i, { ...a, args: { ...a.args, [spec.name]: v } })} />
                ))}
                <button className="icon-btn" onClick={() => up({ actions: key.actions.filter((_, j) => j !== i) })}>✕</button>
              </div>
            );
          })}
          <button onClick={() => up({ actions: [...key.actions, { type: 'muteGroup.toggle', args: { id: 'mg1' } }] })}>+ Add action</button>
        </div>
        <div className="form-group">
          <div className="section-title">Physical triggers</div>
          <div className="row">
            <span className="trigger-label">Hotkey</span>
            <code>{key.hotkey || '—'}</code>
            <button
              className={learning === 'hotkey' ? 'learning' : ''}
              onClick={() => {
                setLearning('hotkey');
                learnHotkey((hk) => {
                  up({ hotkey: hk || undefined });
                  setLearning(null);
                });
              }}
            >
              {learning === 'hotkey' ? 'Press a key… (Esc clears)' : 'Learn'}
            </button>
          </div>
          <p className="hint">Stream Deck: add a “Hotkey” action that sends this key (F13–F24 recommended). Works with Companion, X-keys and any keyboard too.</p>
          <div className="row">
            <span className="trigger-label">MIDI</span>
            <code>{key.midi ? `${(key.midi.status & 0xf0) === 0x90 ? 'Note' : 'CC'} ${key.midi.data1} ch${(key.midi.status & 0x0f) + 1}` : '—'}</code>
            <button
              disabled={!midi.enabled}
              className={learning === 'midi' ? 'learning' : ''}
              onClick={() => {
                setLearning('midi');
                startLearn({ kind: 'key', id });
              }}
            >
              {!midi.enabled ? 'Enable MIDI in I/O' : learning === 'midi' ? 'Press a pad/button…' : 'Learn'}
            </button>
            {key.midi && <button onClick={() => up({ midi: undefined })}>Clear</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
