// The Show page: service automation. Moments act on channel roles, levels are learned,
// and ProPresenter rules decide which moment the service is in.

import { useState } from 'react';
import { contextFromProPresenter, decideMoment, emptyContext, ROLES, applySuggestedRoles, suggestRole, type Moment, type Role, type Rule, type RuleField, type ShowContext } from '../core/moments';
import { newId } from '../core/defaults';
import { useConsole } from '../core/store';
import { useNative } from '../native/bridge';
import { useShow } from '../native/showFollow';

const FIELD_LABEL: Record<RuleField, string> = {
  item: 'Playlist item',
  presentation: 'Presentation',
  group: 'Slide group',
  song: 'Any song (has Verse/Chorus…)',
  media: 'Media is playing',
};

const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

/** ARM, NOW, moment buttons, undo: also shown compact in the Mix view. */
export function MomentBar({ compact }: { compact?: boolean }) {
  const a = useConsole((s) => s.automation);
  const dispatch = useConsole((s) => s.dispatch);
  const decided = useShow((s) => s.decided);
  const now = a.moments.find((m) => m.id === a.current);
  const next = decided && decided.moment !== a.current ? a.moments.find((m) => m.id === decided.moment) : undefined;
  return (
    <div className={'moment-bar' + (compact ? ' compact' : '')}>
      <div className="row between">
        <button
          className={'arm' + (a.armed ? ' on' : '')}
          onClick={() => dispatch({ type: 'automation.arm', args: {} })}
          title="Armed: ProPresenter changes fire moments. Disarmed: nothing changes on its own (buttons still work)."
        >
          {a.armed ? '● ARMED' : '○ DISARMED'}
        </button>
        <div className="now">
          <span className="hint">NOW</span> <b>{now?.name ?? '—'}</b>
          {next && (
            <>
              <span className="hint"> · ProPresenter says {next.name} </span>
              <button className="go small" title="Fire what ProPresenter is calling for" onClick={() => dispatch({ type: 'moment.fire', args: { moment: next.id, source: 'GO' } })}>
                GO
              </button>
            </>
          )}
        </div>
        <button disabled={!a.undo} onClick={() => dispatch({ type: 'moment.undo', args: {} })} title="Put back what the last moment changed">
          ↶ Undo
        </button>
      </div>
      <div className="moment-keys">
        {a.moments
          .filter((m) => m.enabled)
          .map((m) => (
            <button key={m.id} className={'moment-key' + (m.id === a.current ? ' on' : '')} onClick={() => dispatch({ type: 'moment.fire', args: { moment: m.id } })}>
              {m.name}
            </button>
          ))}
      </div>
    </div>
  );
}

function ProPresenterPanel() {
  const pp = useConsole((s) => s.automation.propresenter);
  const update = useConsole((s) => s.update);
  const conn = useNative((s) => s.pp);
  const engine = useNative((s) => s.status === 'connected');
  const ctx = useShow((s) => s.ctx);
  const decided = useShow((s) => s.decided);
  const moments = useConsole((s) => s.automation.moments);
  const set = (patch: Partial<typeof pp>) => update((s) => ({ automation: { ...s.automation, propresenter: { ...s.automation.propresenter, ...patch } } }));
  const light = conn.state === 'connected' || conn.state === 'polling' ? 'ok' : conn.state === 'connecting' ? 'warn' : conn.state === 'error' ? 'bad' : 'off';
  return (
    <div className="panel">
      <div className="panel-title row between">
        <span>ProPresenter</span>
        <span className={'link-light ' + light}>{conn.state === 'polling' ? 'connected (polling)' : conn.state}</span>
      </div>
      <label className="row">
        <input type="checkbox" checked={pp.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Follow ProPresenter
      </label>
      <div className="row">
        <label className="col">
          <span className="hint">Computer (IP address; 127.0.0.1 = this Mac)</span>
          <input value={pp.host} onChange={(e) => set({ host: e.target.value })} style={{ width: 160 }} />
        </label>
        <label className="col">
          <span className="hint">Port</span>
          <input type="number" value={pp.port} onChange={(e) => set({ port: Number(e.target.value) })} style={{ width: 80 }} />
        </label>
      </div>
      <p className="hint">
        In ProPresenter: <b>Settings → Network</b>, turn on <b>Enable Network</b>, and use the port shown there. {!engine && <b>Needs the Merge app (engine) running.</b>}
      </p>
      {pp.enabled && <p className="hint">{conn.message}</p>}
      <div className="pp-now">
        <div><span className="hint">Playlist item</span> {ctx.item || '—'}</div>
        <div><span className="hint">Presentation</span> {ctx.presentation || '—'} {ctx.isSong && <span className="chip on">song</span>}</div>
        <div><span className="hint">Slide group</span> {ctx.group || '—'}</div>
        {ctx.notes && <div><span className="hint">Slide notes</span> {ctx.notes}</div>}
        {ctx.mediaLive && <div><span className="hint">Media</span> playing</div>}
        <div>
          <span className="hint">Calls for</span> <b>{decided ? moments.find((m) => m.id === decided.moment)?.name : 'no change'}</b>
          {decided && <span className="hint"> ({decided.why})</span>}
        </div>
      </div>
    </div>
  );
}

function RulesPanel() {
  const a = useConsole((s) => s.automation);
  const update = useConsole((s) => s.update);
  const setRules = (fn: (r: Rule[]) => Rule[]) => update((s) => ({ automation: { ...s.automation, rules: fn(s.automation.rules) } }));
  const patch = (id: string, p: Partial<Rule>) => setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const move = (i: number, d: number) =>
    setRules((rs) => {
      const n = rs.slice();
      const j = i + d;
      if (j < 0 || j >= n.length) return rs;
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  return (
    <div className="panel">
      <div className="panel-title row between">
        <span>Rules (top to bottom, first match wins)</span>
        <button onClick={() => setRules((rs) => [...rs, { id: newId('rule'), field: 'item', match: '', moment: 'song', enabled: true }])}>+ Rule</button>
      </div>
      <p className="hint">
        Set once, not every week. Text matches if it's contained (case doesn't matter), or use * as a wildcard. A slide's notes can force a moment with
        <code> merge: Sermon</code>.
      </p>
      <table className="list rules">
        <tbody>
          {a.rules.map((r, i) => (
            <tr key={r.id} className={r.enabled ? '' : 'off'}>
              <td><input type="checkbox" checked={r.enabled} onChange={(e) => patch(r.id, { enabled: e.target.checked })} /></td>
              <td>
                <select value={r.field} onChange={(e) => patch(r.id, { field: e.target.value as RuleField })}>
                  {(Object.keys(FIELD_LABEL) as RuleField[]).map((f) => <option key={f} value={f}>{FIELD_LABEL[f]}</option>)}
                </select>
              </td>
              <td>{r.field === 'song' || r.field === 'media' ? <span className="hint">—</span> : <input value={r.match} placeholder="text" onChange={(e) => patch(r.id, { match: e.target.value })} style={{ width: 110 }} />}</td>
              <td>→</td>
              <td>
                <select value={r.moment} onChange={(e) => patch(r.id, { moment: e.target.value })}>
                  {a.moments.map((m) => <option key={m.id} value={m.id}>{m.name}{m.enabled ? '' : ' (off)'}</option>)}
                </select>
              </td>
              <td className="nowrap">
                <button className="icon-btn" onClick={() => move(i, -1)}>↑</button>
                <button className="icon-btn" onClick={() => move(i, 1)}>↓</button>
                <button className="icon-btn" onClick={() => setRules((rs) => rs.filter((x) => x.id !== r.id))}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <RuleTester />
    </div>
  );
}

/** Try the rules without ProPresenter. */
function RuleTester() {
  const a = useConsole((s) => s.automation);
  const dispatch = useConsole((s) => s.dispatch);
  const [t, setT] = useState<ShowContext>(emptyContext());
  const d = decideMoment(t, a);
  const f = (k: keyof ShowContext) => (e: React.ChangeEvent<HTMLInputElement>) => setT({ ...t, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <details className="tester">
      <summary>Test the rules</summary>
      <div className="row wrap">
        <input placeholder="Playlist item" value={t.item} onChange={f('item')} style={{ width: 120 }} />
        <input placeholder="Slide group" value={t.group} onChange={f('group')} style={{ width: 100 }} />
        <input placeholder="Slide notes" value={t.notes} onChange={f('notes')} style={{ width: 120 }} />
        <label className="row"><input type="checkbox" checked={t.isSong} onChange={f('isSong')} /> song</label>
        <label className="row"><input type="checkbox" checked={t.mediaLive} onChange={f('mediaLive')} /> media</label>
      </div>
      <div className="row">
        <span>→ <b>{d ? d.moment.name : 'no change'}</b> {d && <span className="hint">({d.why})</span>}</span>
        {d && <button onClick={() => dispatch({ type: 'moment.fire', args: { moment: d.moment.id, source: 'rule test' } })}>Fire it</button>}
      </div>
    </details>
  );
}

function RoleCycle({ m, role, onChange }: { m: Moment; role: Role; onChange: (m: Moment) => void }) {
  const state = m.open.includes(role) ? 'open' : m.close.includes(role) ? 'close' : 'leave';
  const next = () => {
    const open = m.open.filter((r) => r !== role), close = m.close.filter((r) => r !== role);
    if (state === 'leave') open.push(role);
    else if (state === 'open') close.push(role);
    onChange({ ...m, open, close });
  };
  return (
    <button className={'role-state ' + state} onClick={next} title="Click: open → close → leave alone">
      {state === 'open' ? 'open' : state === 'close' ? 'close' : '·'}
    </button>
  );
}

function MomentsPanel() {
  const a = useConsole((s) => s.automation);
  const update = useConsole((s) => s.update);
  const setMoment = (m: Moment) => update((s) => ({ automation: { ...s.automation, moments: s.automation.moments.map((x) => (x.id === m.id ? m : x)) } }));
  const forget = (id: string) => update((s) => {
    const learned = { ...s.automation.learned };
    delete learned[id];
    return { automation: { ...s.automation, learned } };
  });
  return (
    <div className="panel">
      <div className="panel-title">Moments</div>
      <p className="hint">
        What each moment does to each role. Levels aren't set here: Merge learns them. When a moment ends, it remembers where your open channels sat, and uses those
        levels next time.
      </p>
      <div className="moments-grid" style={{ gridTemplateColumns: `150px 74px repeat(${ROLES.length}, 1fr) 70px` }}>
        <div className="hint">Moment</div>
        <div className="hint">Fade</div>
        {ROLES.map((r) => <div key={r.id} className="hint role-head" title={r.hint}>{r.label.split(' /')[0]}</div>)}
        <div className="hint">Learned</div>
        {a.moments.map((m) => (
          <div key={m.id} className={'moment-row' + (m.enabled ? '' : ' off')} style={{ display: 'contents' }}>
            <label className="row">
              <input type="checkbox" checked={m.enabled} onChange={(e) => setMoment({ ...m, enabled: e.target.checked })} />
              {m.name}
            </label>
            <label className="row">
              <input type="number" min={0} max={10} step={0.5} value={m.fadeMs / 1000} onChange={(e) => setMoment({ ...m, fadeMs: Math.max(0, Number(e.target.value)) * 1000 })} style={{ width: 54 }} />
              <span className="hint">s</span>
            </label>
            {ROLES.map((r) => <RoleCycle key={r.id} m={m} role={r.id} onChange={setMoment} />)}
            <div className="row">
              <span className="hint">{Object.keys(a.learned[m.id] ?? {}).length || '—'}</span>
              {a.learned[m.id] && <button className="link-btn" title="Forget the learned levels for this moment" onClick={() => forget(m.id)}>reset</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RolesPanel() {
  const channels = useConsole((s) => s.channels);
  const update = useConsole((s) => s.update);
  const updateChannel = useConsole((s) => s.updateChannel);
  const [msg, setMsg] = useState('');
  const missing = channels.filter((c) => !c.role).length;
  return (
    <div className="panel">
      <div className="panel-title row between">
        <span>Channel roles</span>
        <button
          onClick={() => {
            let n = 0;
            update((s) => {
              const r = applySuggestedRoles(s);
              n = r.count;
              return { channels: r.state.channels };
            });
            setMsg(n ? `Suggested a role for ${n} channel(s): check them below.` : 'No suggestions: name channels like "Pastor", "Kick", "BV 1", "Tracks".');
          }}
        >
          Suggest from names
        </button>
      </div>
      <p className="hint">
        Moments act on roles, so this is the only setup. {missing > 0 && `${missing} channel(s) have no role: moments leave those alone.`} {msg}
      </p>
      <div className="roles-list">
        {channels.map((c) => {
          const sug = !c.role ? suggestRole(c.name) : undefined;
          return (
            <label key={c.id} className="row role-row">
              <span className="role-ch">{c.id.slice(2)}</span>
              <span className="role-name">{c.name}</span>
              <select value={c.role ?? ''} onChange={(e) => updateChannel(c.id, { role: (e.target.value || undefined) as Role | undefined })}>
                <option value="">— no role —</option>
                {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
              {sug && <span className="hint">suggest: {ROLES.find((r) => r.id === sug)?.label}</span>}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function LogPanel() {
  const log = useShow((s) => s.log);
  return (
    <div className="panel">
      <div className="panel-title">Show log</div>
      {!log.length && <p className="hint">What fired, when and why will be listed here.</p>}
      <div className="show-log">
        {log.map((e, i) => (
          <div key={i} className={'log-' + e.kind}>
            <span className="hint">{fmtTime(e.at)}</span> {e.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ShowView() {
  return (
    <div className="page show-page">
      <div className="panel"><MomentBar /></div>
      <div className="grid2">
        <div className="col">
          <ProPresenterPanel />
          <RulesPanel />
          <LogPanel />
        </div>
        <div className="col">
          <MomentsPanel />
          <RolesPanel />
        </div>
      </div>
    </div>
  );
}

// keep for tests/dev tools: what would ProPresenter's current data decide?
export const debugDecide = () => decideMoment(contextFromProPresenter(useNative.getState().pp.raw), useConsole.getState().automation);
