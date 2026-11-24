// The Show page: service automation. Moments act on channel roles, levels are learned,
// and ProPresenter rules decide which moment the service is in.

import { useState } from 'react';
import { contextFromProPresenter, decideMoment, DEFAULT_MOMENTS, emptyContext, ROLES, applySuggestedRoles, suggestRole, type Moment, type Role, type Rule, type RuleField, type ShowContext } from '../core/moments';
import { newId } from '../core/defaults';
import { useConsole } from '../core/store';
import { pcoGet, sendNative, useNative } from '../native/bridge';
import { clearLabels, findMicNote, labelChannels, micName, parseItems, parseMicNote, parsePlanNotes, parsePlans, parseServiceTypes, pcoPaths, peopleInPlan, samePerson, startOfTodayIso, type PcoState } from '../core/pco';
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
              <button className="go small" title="Fire what ProPresenter is calling for" onClick={() => dispatch({ type: 'moment.fire', args: { moment: next.id, source: 'GO', ...(decided?.focus?.length ? { focus: decided.focus.join(','), leader: decided.leader ?? '' } : {}) } })}>
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
  const channels = useConsole((s) => s.channels);
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
          <span className="hint">ProPresenter computer's IP address</span>
          <input value={pp.host} onChange={(e) => set({ host: e.target.value })} style={{ width: 160 }} />
        </label>
        <label className="col">
          <span className="hint">Port</span>
          <input type="number" value={pp.port} onChange={(e) => set({ port: Number(e.target.value) })} style={{ width: 80 }} />
        </label>
      </div>
      <p className="hint">
        On the ProPresenter computer: <b>Settings → Network</b>, turn on <b>Enable Network</b>; the IP address and port are shown there. Both computers must be on
        the same network (give the ProPresenter computer a fixed IP). {!engine && <b>Needs the Merge app (engine) running.</b>}
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
        {decided?.leader && (
          <div>
            <span className="hint">Led by</span> {decided.leader}{' '}
            {decided.focus?.length ? (
              <span className="hint">→ only {decided.focus.map((id) => channels.find((c) => c.id === id)?.name ?? id).join(', ')} opens</span>
            ) : (
              <span className="hint">(no mic set for them: all speaking mics open)</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PlanningCenterPanel() {
  const linked = useNative((s) => !!s.pcoLinked);
  const engine = useNative((s) => s.status === 'connected');
  const pco = useConsole((s) => s.automation.pco);
  const channels = useConsole((s) => s.channels);
  const update = useConsole((s) => s.update);
  const [types, setTypes] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [cred, setCred] = useState({ appId: '', secret: '' });
  const setPco = (patch: Partial<PcoState>) => update((s) => ({ automation: { ...s.automation, pco: { ...s.automation.pco, ...patch } } }));
  const fail = (what: string, r: { status: number; body: any }) =>
    setErr(`${what}: ${r.status === 401 ? 'Planning Center refused the token (check the application ID and secret)' : r.status === 0 ? String(r.body) : `HTTP ${r.status}`}`);

  const loadTypes = async () => {
    setBusy('Loading service types…'); setErr('');
    const r = await pcoGet(pcoPaths.serviceTypes());
    setBusy('');
    if (r.status !== 200) return fail('Service types', r);
    setTypes(parseServiceTypes(r.body));
  };
  const loadPlan = async () => {
    if (!pco.serviceTypeId) return;
    setBusy('Loading this week\'s plan…'); setErr('');
    const plans = await pcoGet(pcoPaths.upcomingPlans(pco.serviceTypeId, startOfTodayIso()));
    if (plans.status !== 200) { setBusy(''); return fail('Plans', plans); }
    const plan = parsePlans(plans.body)[0];
    if (!plan) { setBusy(''); return setErr('No upcoming plan found for this service type.'); }
    const [items, notes] = await Promise.all([pcoGet(pcoPaths.items(pco.serviceTypeId, plan.id)), pcoGet(pcoPaths.planNotes(pco.serviceTypeId, plan.id))]);
    setBusy('');
    if (items.status !== 200) return fail('Plan items', items);
    const st = useConsole.getState();
    const micNote = notes.status === 200 ? findMicNote(parsePlanNotes(notes.body), st.channels) : '';
    const fromNote = micNote ? parseMicNote(micNote, st.channels) : {};
    setPco({ planId: plan.id, planTitle: plan.title, planDates: plan.dates, items: parseItems(items.body, pco.personCategory), micNote, mics: fromNote, loadedAt: Date.now() });
  };
  const people = peopleInPlan(pco.items);
  const micFor = (p: string) => Object.entries(pco.mics).find(([who]) => samePerson(who, p))?.[1] ?? '';
  const setMic = (p: string, ch: string) => {
    const mics = Object.fromEntries(Object.entries(pco.mics).filter(([who]) => !samePerson(who, p)));
    if (ch) mics[p] = ch;
    setPco({ mics });
  };

  if (!linked)
    return (
      <div className="panel">
        <div className="panel-title">Planning Center</div>
        <p className="hint">
          Link Planning Center so moments open only the mic of the person leading each item (your <b>Person</b> item notes). Create a Personal Access Token at{' '}
          <b>api.planningcenteronline.com/oauth/applications</b> → <b>Personal Access Tokens</b> → <b>New</b>, then paste its Application ID and Secret here. They're
          saved on this computer only (not in show files). {!engine && <b>Needs the Merge app running.</b>}
        </p>
        <div className="row wrap">
          <input placeholder="Application ID" value={cred.appId} onChange={(e) => setCred({ ...cred, appId: e.target.value })} style={{ width: 200 }} />
          <input placeholder="Secret" type="password" value={cred.secret} onChange={(e) => setCred({ ...cred, secret: e.target.value })} style={{ width: 200 }} />
          <button disabled={!engine || !cred.appId || !cred.secret} onClick={() => { sendNative({ type: 'pco.credentials', ...cred }); setCred({ appId: '', secret: '' }); }}>
            Link
          </button>
        </div>
      </div>
    );

  return (
    <div className="panel">
      <div className="panel-title row between">
        <span>Planning Center</span>
        <button className="link-btn" onClick={() => sendNative({ type: 'pco.credentials', appId: '', secret: '' })} title="Remove the saved token from this computer">unlink</button>
      </div>
      <div className="row wrap">
        <select
          value={pco.serviceTypeId}
          onFocus={() => !types.length && loadTypes()}
          onChange={(e) => setPco({ serviceTypeId: e.target.value, serviceTypeName: types.find((t) => t.id === e.target.value)?.name ?? '' })}
        >
          <option value="">{pco.serviceTypeName || '— service type —'}</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button className="go" disabled={!pco.serviceTypeId || !!busy} onClick={loadPlan}>Load this week's plan</button>
        <label className="row">
          <span className="hint">Person note category</span>
          <input value={pco.personCategory} onChange={(e) => setPco({ personCategory: e.target.value })} style={{ width: 80 }} />
        </label>
      </div>
      {busy && <p className="hint">{busy}</p>}
      {err && <p className="hint bad-text">{err}</p>}
      {pco.planId && (
        <>
          <p className="hint">
            <b>{pco.planTitle || 'Plan'}</b> {pco.planDates} · loaded {new Date(pco.loadedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
            {pco.micNote ? ' · mics read from your production note' : ' · no mic note found: set mics below'}
          </p>
          <div className="pco-mics">
            <div className="hint">Mics this week</div>
            {!people.length && <p className="hint">No Person notes in this plan.</p>}
            {people.map((p) => (
              <label key={p} className="row">
                <span className="pco-person">{p}</span>
                <select value={micFor(p)} onChange={(e) => setMic(p, e.target.value)}>
                  <option value="">— no mic —</option>
                  {channels.map((c) => <option key={c.id} value={c.id}>{c.id.slice(2)} · {micName(c)}</option>)}
                </select>
              </label>
            ))}
            <div className="row">
              <button onClick={() => update((s) => ({ channels: labelChannels(s.channels, s.automation.pco.mics) }))} title="Name the strips 'HH1 · Sarah' for this week">Label strips</button>
              <button onClick={() => update((s) => ({ channels: clearLabels(s.channels) }))}>Clear labels</button>
            </div>
          </div>
          <details>
            <summary className="hint">Service order ({pco.items.length} items)</summary>
            <table className="list">
              <tbody>
                {pco.items.map((i, n) => (
                  <tr key={n}><td>{i.title}</td><td className="hint">{i.person || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
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
      <div className="panel-title row between">
        <span>Moments</span>
        <button
          className="link-btn"
          title="Put the moments' open/close settings and fade times back to the defaults (learned levels are kept)"
          onClick={() => update((s) => ({ automation: { ...s.automation, moments: DEFAULT_MOMENTS.map((m) => ({ ...m })) } }))}
        >
          reset to defaults
        </button>
      </div>
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
          const sug = !c.role ? suggestRole(c.baseName ?? c.name) : undefined;
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
          <PlanningCenterPanel />
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
