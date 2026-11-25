// The right-side drawer: settings for the selected channel/bus/DCA/main (or a user key).
// Opens when a strip is selected on the console; closes with ✕ or Esc.
// Plugin GUIs open in their own floating windows (see the rack), not in here.

import { useEffect } from 'react';
import { useConsole } from '../core/store';
import { Detail } from './Detail';
import { KeyEditor } from './UserKeys';
import { Inspector } from './Inspector';
import { closeDrawer, useUi } from './uiState';

export function ChannelDrawer({ pinned = false }: { pinned?: boolean }) {
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
    if (!drawerOpen || pinned) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select')) return; // Esc inside a field just leaves the field
      closeDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen, pinned]);
  const ch = useConsole((s) => (sel?.kind === 'channel' ? s.channels.find((c) => c.id === sel.id) : undefined));
  if (!drawerOpen && !pinned) return null;
  // channels: the no-scroll inspector (it has its own name row)
  if (ch && !editKey)
    return (
      <aside className={'drawer' + (pinned ? ' pinned' : '')} aria-label="Channel settings">
        <Inspector ch={ch} closable={!pinned} />
      </aside>
    );
  return (
    <aside className={'drawer' + (pinned ? ' pinned' : '')} aria-label="Channel settings">
      <div className="drawer-head">
        <span className="drawer-title">{editKey ? 'Edit user key' : label}</span>
        <div className="spacer" />
        {(!pinned || editKey) && <button className="icon-btn" title={pinned ? 'Back to the channel' : 'Close (Esc)'} onClick={closeDrawer}>✕</button>}
      </div>
      <div className="drawer-body">{editKey ? <KeyEditor id={editKey} onClose={closeDrawer} /> : <Detail />}</div>
    </aside>
  );
}
