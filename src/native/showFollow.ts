// Follows ProPresenter: turns what it's showing into a show moment, and fires it when the
// moment the service calls for *changes* (and automation is armed). A moment fired by hand
// stays until ProPresenter moves on to something that calls for a different moment.

import { create } from 'zustand';
import { contextFromProPresenter, decideMoment, emptyContext, type ShowContext } from '../core/moments';
import { useConsole } from '../core/store';
import { uiLog, useNative } from './bridge';

export interface LogEntry {
  at: number;
  text: string;
  kind: 'moment' | 'link' | 'info';
}

interface ShowState {
  ctx: ShowContext;
  /** what the rules say right now (fires only when this changes) */
  decided: { moment: string; why: string } | null;
  log: LogEntry[];
}

export const useShow = create<ShowState>(() => ({ ctx: emptyContext(), decided: null, log: [] }));

export function addLog(text: string, kind: LogEntry['kind'] = 'info') {
  useShow.setState((st) => ({ log: [{ at: Date.now(), text, kind }, ...st.log].slice(0, 200) }));
}

let started = false;
export function startShowFollow() {
  if (started) return;
  started = true;

  // log what automation does, from any source (buttons, keys, Stream Deck, ProPresenter)
  let lastEventAt = useConsole.getState().automation.lastEvent?.at ?? 0;
  useConsole.subscribe((s) => {
    const e = s.automation.lastEvent;
    if (e && e.at !== lastEventAt) {
      lastEventAt = e.at;
      addLog(e.text, 'moment');
      uiLog(`[show] ${e.text}`);
    }
  });

  // connection changes
  useNative.subscribe((st, prev) => {
    if (st.pp.state !== prev.pp.state) addLog(`ProPresenter: ${st.pp.message}`, 'link');
  });

  // ProPresenter data → context → decision → fire
  const evaluate = () => {
    const raw = useNative.getState().pp.raw;
    const ctx = contextFromProPresenter(raw);
    const s = useConsole.getState();
    const d = decideMoment(ctx, s.automation);
    const decided = d ? { moment: d.moment.id, why: d.why } : null;
    const prev = useShow.getState().decided;
    useShow.setState({ ctx, decided });
    const changed = decided && decided.moment !== prev?.moment;
    if (!changed || !decided) return;
    if (!s.automation.armed) {
      addLog(`ProPresenter calls for ${d!.moment.name} (${d!.why}): not armed, nothing changed`);
      return;
    }
    if (s.automation.current === decided.moment) return;
    s.dispatch({ type: 'moment.fire', args: { moment: decided.moment, source: `ProPresenter: ${decided.why}` } });
  };
  useNative.subscribe((st, prev) => {
    if (st.pp.raw !== prev.pp.raw) evaluate();
  });
  // re-check when the rules or moments are edited
  useConsole.subscribe((s, p) => {
    if (s.automation.rules !== p.automation.rules || s.automation.moments !== p.automation.moments) {
      useShow.setState({ decided: null }); // re-decide from scratch, but don't fire just for an edit
      const ctx = contextFromProPresenter(useNative.getState().pp.raw);
      const d = decideMoment(ctx, s.automation);
      useShow.setState({ ctx, decided: d ? { moment: d.moment.id, why: d.why } : null });
    }
  });
}
