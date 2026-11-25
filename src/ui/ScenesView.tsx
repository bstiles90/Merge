import { SAFE_PARTS, isSafe, takeSnapshot } from '../core/scenes';
import type { SafePart } from '../core/types';
import { createdBuses } from '../core/buses';
import { newId } from '../core/defaults';
import { useConsole } from '../core/store';
import type { SceneScope } from '../core/types';
import { Toggle } from './controls';

const SCOPE_LABELS: Record<keyof SceneScope, string> = { channels: 'Channels', buses: 'Buses', main: 'Main LR', dcas: 'DCAs', muteGroups: 'Mute groups' };

export function ScenesView() {
  const s = useConsole();
  const scopeKeys: (keyof SceneScope)[] = ['channels', 'buses', 'main', 'dcas', 'muteGroups'];
  const store = () => {
    const id = newId('sc');
    s.update((st) => ({ scenes: [...st.scenes, { id, name: `Scene ${st.scenes.length + 1}`, snapshot: takeSnapshot(st) }], currentScene: id }));
  };
  const move = (i: number, d: number) =>
    s.update((st) => {
      const n = st.scenes.slice();
      const j = i + d;
      if (j < 0 || j >= n.length) return {};
      [n[i], n[j]] = [n[j], n[i]];
      return { scenes: n };
    });

  return (
    <div className="page grid2">
      <div className="panel">
        <div className="panel-title row between">
          <span>Scenes / snapshots</span>
          <div className="row">
            <button onClick={() => s.dispatch({ type: 'scene.prev', args: {} })}>◀ Prev</button>
            <button className="go" onClick={() => s.dispatch({ type: 'scene.next', args: {} })}>GO ▶</button>
            <button onClick={store}>+ Store new</button>
          </div>
        </div>
        {!s.scenes.length && <p className="hint">No scenes yet. Set up the mix and hit “Store new”. Assign Scene Go/Prev to user keys for one-button show running.</p>}
        <table className="list">
          <tbody>
            {s.scenes.map((sc, i) => (
              <tr key={sc.id} className={sc.id === s.currentScene ? 'current' : ''}>
                <td>{i + 1}</td>
                <td>
                  <input
                    value={sc.name}
                    onChange={(e) => s.update((st) => ({ scenes: st.scenes.map((x) => (x.id === sc.id ? { ...x, name: e.target.value } : x)) }))}
                  />
                </td>
                <td className="scene-fade" title="Fade time when this scene is recalled: faders, sends, pan and gain glide; mutes, routing and plugins switch at the start. 0 = instant.">
                  <input
                    type="number"
                    min={0}
                    max={60}
                    step={0.5}
                    value={(sc.fadeMs ?? 0) / 1000}
                    onChange={(e) => {
                      const sec = Math.max(0, Math.min(60, Number(e.target.value) || 0));
                      s.update((st) => ({ scenes: st.scenes.map((x) => (x.id === sc.id ? { ...x, fadeMs: Math.round(sec * 1000) } : x)) }));
                    }}
                  />
                  <span className="hint">s fade</span>
                </td>
                <td>
                  <button className="go" onClick={() => s.dispatch({ type: 'scene.recall', args: { id: sc.id } })}>Recall</button>
                  <button
                    onClick={() => s.update((st) => ({ scenes: st.scenes.map((x) => (x.id === sc.id ? { ...x, snapshot: takeSnapshot(st) } : x)) }))}
                    title="Overwrite with the current mix"
                  >
                    Update
                  </button>
                  <button className="icon-btn" onClick={() => move(i, -1)}>↑</button>
                  <button className="icon-btn" onClick={() => move(i, 1)}>↓</button>
                  <button className="icon-btn" onClick={() => s.update((st) => ({ scenes: st.scenes.filter((x) => x.id !== sc.id) }))}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="col">
        <div className="panel">
          <div className="panel-title">Recall scope</div>
          <p className="hint">Which sections a recall changes. Input source, mono/stereo, solo, record-arm and playback mode are never recalled.</p>
          <div className="row wrap">
            {scopeKeys.map((k) => (
              <Toggle key={k} on={s.sceneScope[k]} onClick={() => s.update((st) => ({ sceneScope: { ...st.sceneScope, [k]: !st.sceneScope[k] } }))}>
                {SCOPE_LABELS[k]}
              </Toggle>
            ))}
          </div>
        </div>
        <SafesPanel />
      </div>
    </div>
  );
}

/** LV1-style recall safes: whole strips or parts of them (and single plugin slots, from the
 *  lock on each plugin in the RACK tab). */
function SafesPanel() {
  const s = useConsole();
  const strips = [
    ...s.channels.map((c) => ({ kind: 'channel' as const, id: c.id, name: c.name, color: c.color, all: c.recallSafe, safe: c.safe ?? {}, slots: c.inserts.filter((i) => i.recallSafe).length })),
    ...createdBuses(s).map((b) => ({ kind: 'bus' as const, id: b.id, name: b.name, color: b.color, all: b.recallSafe, safe: b.safe ?? {}, slots: b.inserts.filter((i) => i.recallSafe).length })),
  ];
  const toggle = (st: (typeof strips)[number], part: SafePart | 'all') => {
    if (st.kind === 'channel') {
      s.updateChannel(st.id, (c) => (part === 'all' ? { recallSafe: !c.recallSafe } : { safe: { ...c.safe, [part]: !c.safe?.[part] } }));
    } else {
      s.updateBus(st.id, (b) => (part === 'all' ? { recallSafe: !b.recallSafe } : { safe: { ...b.safe, [part]: !b.safe?.[part] } }));
    }
  };
  const busParts: SafePart[] = ['input', 'fader', 'mute', 'routing', 'groups', 'inserts', 'name'];
  return (
    <div className="panel safes-panel">
      <div className="panel-title">Recall safes</div>
      <p className="hint">Safe parts are left alone by every scene recall, e.g. a presenter's fader you're riding live, or one plugin slot. Single plugin slots: the lock on each plugin in a channel's RACK tab.</p>
      <div className="safes-scroll">
        <table className="safes">
          <thead>
            <tr>
              <th className="sf-name">Strip</th>
              <th title="Everything on this strip">ALL</th>
              {SAFE_PARTS.map((p) => <th key={p.id} title={p.about}>{p.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {strips.map((st) => (
              <tr key={st.id} className={st.all ? 'all-safe' : ''}>
                <td className="sf-name"><span className="dot" style={{ background: st.color }} /> {st.name}</td>
                <td className={'sf-cell all' + (st.all ? ' on' : '')} onClick={() => toggle(st, 'all')}>{st.all ? '●' : ''}</td>
                {SAFE_PARTS.map((p) => {
                  const na = st.kind === 'bus' && !busParts.includes(p.id);
                  const on = !na && isSafe({ recallSafe: st.all, safe: st.safe }, p.id);
                  const partial = p.id === 'inserts' && !on && st.slots > 0;
                  return (
                    <td
                      key={p.id}
                      className={'sf-cell' + (on ? ' on' : '') + (na ? ' na' : '') + (partial ? ' partial' : '')}
                      title={na ? 'Not on buses' : partial ? `${st.slots} plugin slot(s) locked` : `${p.label}: ${p.about}`}
                      onClick={() => !na && !st.all && toggle(st, p.id)}
                    >
                      {on ? '●' : partial ? st.slots : ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
