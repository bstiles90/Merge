// Macros: named, timed sequences run from one button (assign with a user key's "Run macro").
// Steps: any action, a fader move over a time, or a wait.

import { useState } from 'react';
import { ACTIONS, describeAction } from '../core/actions';
import { newId, PALETTE } from '../core/defaults';
import { describeStep } from '../core/macros';
import { services } from '../core/services';
import { useConsole } from '../core/store';
import type { ActionCall, Macro, MacroStep } from '../core/types';
import { StripRefSelect } from './Pages';
import { ArgInput } from './UserKeys';
import { ColorPicker } from './Detail';

function StepEditor({ step, onChange, onRemove, onMove }: { step: MacroStep; onChange: (s: MacroStep) => void; onRemove: () => void; onMove: (d: -1 | 1) => void }) {
  const s = useConsole();
  const categories = [...new Set([...ACTIONS.values()].filter((a) => !a.type.startsWith('macro.')).map((a) => a.category))];
  const kindSelect = (
    <select
      className="step-kind"
      value={step.kind}
      onChange={(e) => {
        const k = e.target.value as MacroStep['kind'];
        if (k === 'action') onChange({ kind: 'action', call: { type: 'muteGroup.toggle', args: { id: 'mg1' } } });
        else if (k === 'fade') onChange({ kind: 'fade', target: { kind: 'channel', id: 'ch1' }, db: 0, sec: 3 });
        else onChange({ kind: 'wait', sec: 1 });
      }}
    >
      <option value="fade">Fader move</option>
      <option value="action">Action</option>
      <option value="wait">Wait</option>
    </select>
  );
  let body: React.ReactNode = null;
  if (step.kind === 'fade') {
    body = (
      <>
        <StripRefSelect value={step.target} onChange={(r) => r && onChange({ ...step, target: r })} />
        <label className="row">to <input type="number" step={0.5} min={-90} max={10} value={step.db} onChange={(e) => onChange({ ...step, db: Number(e.target.value) })} style={{ width: 62 }} /> dB</label>
        <label className="row">over <input type="number" step={0.5} min={0} max={120} value={step.sec} onChange={(e) => onChange({ ...step, sec: Math.max(0, Number(e.target.value)) })} style={{ width: 56 }} /> s</label>
        <label className="row hint" title="Off: the next steps start right away (move several faders together). On: wait for this move to finish first.">
          <input type="checkbox" checked={!!step.wait} onChange={(e) => onChange({ ...step, wait: e.target.checked })} /> wait for it
        </label>
      </>
    );
  } else if (step.kind === 'wait') {
    body = <label className="row"><input type="number" step={0.5} min={0} max={600} value={step.sec} onChange={(e) => onChange({ ...step, sec: Math.max(0, Number(e.target.value)) })} style={{ width: 62 }} /> seconds</label>;
  } else {
    const def = ACTIONS.get(step.call.type);
    const setCall = (call: ActionCall) => onChange({ kind: 'action', call });
    body = (
      <>
        <select
          value={step.call.type}
          onChange={(e) => {
            const d = ACTIONS.get(e.target.value)!;
            setCall({ type: d.type, args: Object.fromEntries(d.args.map((x) => [x.name, x.default ?? ''])) as ActionCall['args'] });
          }}
        >
          {categories.map((cat) => (
            <optgroup key={cat} label={cat}>
              {[...ACTIONS.values()].filter((d) => d.category === cat && !d.type.startsWith('macro.')).map((d) => <option key={d.type} value={d.type}>{d.label}</option>)}
            </optgroup>
          ))}
        </select>
        {def?.args.map((spec) => (
          <ArgInput key={spec.name} spec={spec} s={s} value={step.call.args[spec.name]} onChange={(v) => setCall({ ...step.call, args: { ...step.call.args, [spec.name]: v } })} />
        ))}
      </>
    );
  }
  return (
    <div className={'macro-step ' + step.kind}>
      {kindSelect}
      {body}
      <span className="spacer" />
      <button className="icon-btn" title="Move up" onClick={() => onMove(-1)}>↑</button>
      <button className="icon-btn" title="Move down" onClick={() => onMove(1)}>↓</button>
      <button className="icon-btn" title="Remove step" onClick={onRemove}>✕</button>
    </div>
  );
}

function MacroEditor({ macro }: { macro: Macro }) {
  const s = useConsole();
  const up = (p: Partial<Macro>) => s.update((st) => ({ macros: (st.macros ?? []).map((m) => (m.id === macro.id ? { ...m, ...p } : m)) }));
  const setStep = (i: number, step: MacroStep) => up({ steps: macro.steps.map((x, j) => (j === i ? step : x)) });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= macro.steps.length) return;
    const n = macro.steps.slice();
    [n[i], n[j]] = [n[j], n[i]];
    up({ steps: n });
  };
  return (
    <div className="macro-editor">
      <div className="row wrap">
        <input className="macro-name" value={macro.name} onChange={(e) => up({ name: e.target.value })} />
        <ColorPicker value={macro.color} onChange={(color) => up({ color })} />
      </div>
      <div className="macro-steps">
        {macro.steps.map((st, i) => (
          <StepEditor key={i} step={st} onChange={(x) => setStep(i, x)} onRemove={() => up({ steps: macro.steps.filter((_, j) => j !== i) })} onMove={(d) => move(i, d)} />
        ))}
        {!macro.steps.length && <p className="hint">No steps yet.</p>}
      </div>
      <div className="row wrap">
        <button onClick={() => up({ steps: [...macro.steps, { kind: 'fade', target: { kind: 'channel', id: 'ch1' }, db: 0, sec: 3 }] })}>+ Fader move</button>
        <button onClick={() => up({ steps: [...macro.steps, { kind: 'action', call: { type: 'muteGroup.toggle', args: { id: 'mg1' } } }] })}>+ Action</button>
        <button onClick={() => up({ steps: [...macro.steps, { kind: 'wait', sec: 1 }] })}>+ Wait</button>
      </div>
      <p className="hint">Steps run top to bottom. Fader moves run alongside the next steps (move several faders together) unless "wait for it" is ticked. To put a macro on a button: edit a user key and choose the action "Run macro".</p>
    </div>
  );
}

export function MacrosPanel() {
  const s = useConsole();
  const macros = s.macros ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const add = () => {
    const id = newId('mac');
    s.update((st) => ({
      macros: [
        ...(st.macros ?? []),
        {
          id,
          name: `Macro ${(st.macros ?? []).length + 1}`,
          color: PALETTE[(st.macros ?? []).length % 8],
          steps: [
            { kind: 'fade', target: { kind: 'channel', id: 'ch7' }, db: -90, sec: 4 },
            { kind: 'fade', target: { kind: 'channel', id: 'ch1' }, db: 0, sec: 2 },
          ],
        },
      ],
    }));
    setOpen(id);
  };
  return (
    <div className="panel macros-panel">
      <div className="panel-title row between">
        <span>Macros</span>
        <button onClick={add}>+ New macro</button>
      </div>
      <p className="hint">A macro runs several things from one button, like a ProPresenter macro: fader moves with their own times, actions (mute groups, scenes, pages, mutes...) and waits.</p>
      {macros.map((m) => {
        const running = s.macrosRunning?.includes(m.id);
        return (
          <div key={m.id} className={'macro' + (open === m.id ? ' open' : '')} style={{ ['--kc' as string]: m.color }}>
            <div className="macro-head">
              <button className={'macro-run' + (running ? ' running' : '')} title={running ? 'Stop' : 'Run now'} onClick={() => (running ? services.stopMacro(m.id) : services.runMacro(m.id))}>
                {running ? '■' : '▶'}
              </button>
              <button className="macro-title" onClick={() => setOpen(open === m.id ? null : m.id)}>
                <b>{m.name}</b>
                <span className="hint">{m.steps.length ? m.steps.map((st) => describeStep(s, st, (st2, c) => describeAction(st2, c.call))).join(' → ') : 'no steps'}</span>
              </button>
              <button className="icon-btn" title="Delete macro" onClick={() => s.update((st) => ({ macros: (st.macros ?? []).filter((x) => x.id !== m.id) }))}>✕</button>
            </div>
            {open === m.id && <MacroEditor macro={m} />}
          </div>
        );
      })}
      {!macros.length && <p className="hint">No macros yet.</p>}
    </div>
  );
}
