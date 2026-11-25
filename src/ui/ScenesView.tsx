import { takeSnapshot } from '../core/scenes';
import { createdBuses } from '../core/buses';
import { newId } from '../core/defaults';
import { useConsole } from '../core/store';
import type { SceneScope } from '../core/types';
import { Toggle } from './controls';

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
          <p className="hint">Which sections a recall changes. Solo, record-arm, input source and playback mode are never recalled.</p>
          <div className="row wrap">
            {scopeKeys.map((k) => (
              <Toggle key={k} on={s.sceneScope[k]} onClick={() => s.update((st) => ({ sceneScope: { ...st.sceneScope, [k]: !st.sceneScope[k] } }))}>
                {k}
              </Toggle>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-title">Recall safe</div>
          <p className="hint">Safed strips are skipped by every recall — e.g. a presenter mic you're riding live.</p>
          <div className="chips">
            {s.channels.map((c) => (
              <button key={c.id} className={'chip safe' + (c.recallSafe ? ' on' : '')} onClick={() => s.updateChannel(c.id, { recallSafe: !c.recallSafe })}>
                {c.name}
              </button>
            ))}
            {createdBuses(s).map((b) => (
              <button key={b.id} className={'chip safe' + (b.recallSafe ? ' on' : '')} onClick={() => s.updateBus(b.id, { recallSafe: !b.recallSafe })}>
                {b.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
