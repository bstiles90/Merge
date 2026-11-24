// View state for this machine (not part of the show): the plugin dock.
import { create } from 'zustand';

interface UiState {
  dockOpen: boolean;
  dockHeight: number;
  /** insert slot shown in the dock's plugin area */
  dockSlot: string | null;
}

const load = (): UiState => {
  try {
    const v = JSON.parse(localStorage.getItem('merge.ui.v1') || '{}');
    return { dockOpen: v.dockOpen ?? true, dockHeight: v.dockHeight ?? 330, dockSlot: null };
  } catch {
    return { dockOpen: true, dockHeight: 330, dockSlot: null };
  }
};

export const useUi = create<UiState>(load);
useUi.subscribe((s) => {
  try {
    localStorage.setItem('merge.ui.v1', JSON.stringify({ dockOpen: s.dockOpen, dockHeight: s.dockHeight }));
  } catch {
    /* storage unavailable */
  }
});

/** Show a plugin in the dock (opens the dock). */
export const openInDock = (slotId: string) => useUi.setState({ dockSlot: slotId, dockOpen: true });
