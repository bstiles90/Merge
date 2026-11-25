// The right-side drawer: settings for the selected channel/bus/DCA/main (or a user key).
// Opens when a strip is selected on the console; closes with ✕ or Esc.
// Plugin GUIs open in their own floating windows (see the rack), not in here.

import { useEffect } from 'react';
import { useConsole } from '../core/store';
import { Detail } from './Detail';
import { KeyEditor } from './UserKeys';
import { closeDrawer, useUi } from './uiState';

export function ChannelDrawer() {
  const { drawerOpen, editKey } = useUi();
  const sel = useConsole((s) => s.selected);
  const label = useConsole((s) => {
    if (!sel) return 'Nothing selected';
    if (sel.kind === 'channel') return `Ch ${sel.id.slice(2)} · ${s.channels.find((c) => c.id === sel.id)?.name}`;
    if (sel.kind === 'bus') return s.buses.find((b) => b.id === sel.id)?.name ?? '';
    if (sel.kind === 'dca') return s.dcas.find((d) => d.id === sel.id)?.name ?? '';
    return 'Main LR';
  });
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select')) return; // Esc inside a field just leaves the field
      closeDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);
  if (!drawerOpen) return null;
  return (
    <aside className="drawer" aria-label="Channel settings">
      <div className="drawer-head">
        <span className="drawer-title">{editKey ? 'Edit user key' : label}</span>
        <div className="spacer" />
        <button className="icon-btn" title="Close (Esc)" onClick={closeDrawer}>✕</button>
      </div>
      <div className="drawer-body">{editKey ? <KeyEditor id={editKey} onClose={closeDrawer} /> : <Detail />}</div>
    </aside>
  );
}
